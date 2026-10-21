import { Contract } from 'trac-peer'
import { computeSplit, MEMBER_FEE_TIERS } from './split.mjs'

// RESET Mining Pool ledger contract — v6 "tiered + immutable".
//
// Design rules honored here (from the intercom template):
// - No try-catch, no throws, no randomness, no Date.now(), no I/O.
//   Anything time-like arrives inside the tx payload (operator-supplied).
// - All amounts are integer base units as decimal strings (RESET: 8 dp).
// - All state writes (this.put) happen at the end of each function.
// - Operator-only functions check this.address against config.operator.
//
// v5 immutability: the pool's economic parameters are fixed at pool_init and
// there is NO admin setter anywhere in this contract. Specifically:
//   * minDeposit, minPayout, feeReceiver, stakerShareBps and
//     minStakerPrincipal are written once and never changed again.
//   * there is no op that moves principal or member earnings.
//   * fee_sweep can only ever pay the single configured feeReceiver, and only
//     up to what that round actually accrued.
//   * dust_sweep can only ever move the integer-division remainder that no
//     member was credited with.
// The operator can therefore be audited but not silently re-parameterised:
// changing any of these requires a contract upgrade, which every peer must
// apply together (state diverges otherwise).
//
// Money flow: members register a RESET address -> operator credits verified
// deposits -> operator snapshots principals per round -> operator settles a
// round payout, split pro-rata minus the member's tier fee (fee accrues to the single
// feeReceiver, swept separately) -> members request payouts of earnings and
// exits of principal, operator marks them paid after the real RESET transfer
// happens off-contract.

const ADDR = { type: 'string', pattern: /^[0-9a-f]{64}$/ };
const AMOUNT = { type: 'string', pattern: /^[0-9]{1,24}$/ };
const TXREF = { type: 'string', min: 1, max: 128 };
const ROUND = { type: 'number', integer: true, min: 0 };

class PoolContract extends Contract {
  constructor(protocol, options = {}) {
    super(protocol, options);

    // feeReceiver is optional at init: the operator may start the pool before
    // the vault exists. Once set (setFeeReceiver, allowed exactly once) it is
    // frozen forever. Until then fees accrue but cannot be swept.
    this.addSchema('poolInit', { value: { $$strict: true, $$type: 'object',
      poolWallet: ADDR, feeReceiver: ADDR } });
    this.addSchema('setFeeReceiver', { value: { $$strict: true, $$type: 'object',
      feeReceiver: ADDR } });
    this.addSchema('memberRegister', { value: { $$strict: true, $$type: 'object',
      member: ADDR } });
    this.addSchema('setStaker', { value: { $$strict: true, $$type: 'object',
      member: ADDR, enabled: { type: 'boolean' } } });
    this.addSchema('depositCredit', { value: { $$strict: true, $$type: 'object',
      member: ADDR, amount: AMOUNT, txRef: TXREF } });
    this.addSchema('roundSnapshot', { value: { $$strict: true, $$type: 'object',
      round: ROUND } });
    this.addSchema('roundSettle', { value: { $$strict: true, $$type: 'object',
      round: ROUND, amount: AMOUNT } });
    this.addSchema('payoutRequest', { value: { $$strict: true, $$type: 'object',
      member: ADDR, amount: AMOUNT } });
    this.addSchema('payoutPaid', { value: { $$strict: true, $$type: 'object',
      id: { type: 'string', min: 1, max: 64 }, txRef: TXREF } });
    this.addSchema('payoutCancel', { value: { $$strict: true, $$type: 'object',
      id: { type: 'string', min: 1, max: 64 } } });
    this.addSchema('exitRequest', { value: { $$strict: true, $$type: 'object',
      member: ADDR, amount: AMOUNT } });
    this.addSchema('exitPaid', { value: { $$strict: true, $$type: 'object',
      id: { type: 'string', min: 1, max: 64 }, txRef: TXREF } });
    this.addSchema('feeSweep', { value: { $$strict: true, $$type: 'object',
      amount: AMOUNT, txRef: TXREF } });
    this.addSchema('dustSweep', { value: { $$strict: true, $$type: 'object',
      amount: AMOUNT, txRef: TXREF } });
    this.addSchema('solvencyRead', { value: { $$strict: true, $$type: 'object',
      onchain: AMOUNT } });
    this.addSchema('memberRead', { value: { $$strict: true, $$type: 'object',
      member: ADDR } });

    this.addFunction('poolRead');
  }

  async cfg() { return await this.get('config'); }
  async totals() {
    const t = await this.get('totals');
    if (t) return t;
    return { principal: '0', earningsOwed: '0', feesAccrued: '0', feesSwept: '0', dust: '0' };
  }
  async counters() { return (await this.get('counters')) || { payout: 0, exit: 0 }; }
  isOp(config) { return config && this.address === config.operator; }
  amt(x) { const b = this.protocol.safeBigInt(x); this.assert(b !== null && b > 0n, new Error('bad amount')); return b; }

  // One-shot init. Every economic parameter is frozen here.
  async poolInit() {
    if (await this.get('config')) return false;
    // A fee receiver that is also the pool wallet would mix member principal
    // with operator fees.
    if (this.value.feeReceiver === this.value.poolWallet) return false;
    const config = {
      operator: this.address,
      poolWallet: this.value.poolWallet,
      feeMode: 'tiered-v6-immutable',
      feeReceiver: this.value.feeReceiver, // may be null until setFeeReceiver
      feeReceiverLocked: this.value.feeReceiver !== null,
      minDeposit: '100000',               // 0.001 RESET, frozen
      minPayout: '1000000',               // 0.01 RESET, frozen
      stakerShareBps: 5000,               // frozen
      minStakerPrincipal: '50000000'      // 0.5 RESET, frozen
    };
    await this.put('config', config);
    await this.put('members', []);
    await this.put('totals', await this.totals());
    await this.put('counters', await this.counters());
  }

  // The fee receiver may be set exactly once, and only while it is still empty.
  // After that the field is permanently locked: there is no op to change it.
  async setFeeReceiver() {
    const config = await this.cfg();
    if (!this.isOp(config)) return false;
    if (config.feeReceiverLocked) return false;
    if (this.value.feeReceiver === config.poolWallet) return false;
    config.feeReceiver = this.value.feeReceiver;
    config.feeReceiverLocked = true;
    await this.put('config', config);
  }

  async memberRegister() {
    const config = await this.cfg();
    if (!config) return false;
    const member = this.value.member;
    const existing = await this.get('member/' + member);
    if (existing) return existing.peer === this.address;
    const members = (await this.get('members')) || [];
    members.push(member);
    await this.put('member/' + member, { peer: this.address, principal: '0', earnings: '0', exiting: '0', staker: false });
    await this.put('members', members);
  }

  // Operator-only whitelist: mark/unmark a registered member as staker.
  // Takes effect from the NEXT round snapshot; a round already snapshotted
  // keeps the staker set frozen inside its round record.
  async setStaker() {
    const config = await this.cfg();
    if (!this.isOp(config)) return false;
    const rec = await this.get('member/' + this.value.member);
    if (!rec) return false;
    rec.staker = this.value.enabled === true;
    await this.put('member/' + this.value.member, rec);
  }

  async depositCredit() {
    const config = await this.cfg();
    if (!this.isOp(config)) return false;
    const { member, amount, txRef } = this.value;
    if (await this.get('deposit/' + txRef)) return false; // idempotent per transfer
    const rec = await this.get('member/' + member);
    if (!rec) return false;
    // A member with a pending exit cannot add principal: the snapshot would
    // count new money while the old money is still queued out.
    if (this.protocol.safeBigInt(rec.exiting) > 0n) return false;
    const amt = this.amt(amount);
    if (amt < this.protocol.safeBigInt(config.minDeposit)) return false;
    const totals = await this.totals();
    rec.principal = (this.protocol.safeBigInt(rec.principal) + amt).toString();
    totals.principal = (this.protocol.safeBigInt(totals.principal) + amt).toString();
    await this.put('deposit/' + txRef, { member, amount });
    await this.put('member/' + member, rec);
    await this.put('totals', totals);
  }

  async roundSnapshot() {
    const config = await this.cfg();
    if (!this.isOp(config)) return false;
    const key = 'round/' + this.value.round;
    if (await this.get(key)) return false;
    const members = (await this.get('members')) || [];
    const snapshot = {};
    const stakers = [];
    let total = 0n;
    for (const member of members) {
      const rec = await this.get('member/' + member);
      const p = rec ? this.protocol.safeBigInt(rec.principal) : null;
      if (rec && p !== null && p > 0n) {
        snapshot[member] = rec.principal;
        total += p;
        if (rec.staker === true) stakers.push(member);
      }
    }
    await this.put(key, { total: total.toString(), snapshot, stakers, settled: null, fee: null, dust: null });
  }

  async roundSettle() {
    const config = await this.cfg();
    if (!this.isOp(config)) return false;
    const key = 'round/' + this.value.round;
    const round = await this.get(key);
    if (!round || round.settled !== null) return false;
    const split = computeSplit(round.snapshot, this.value.amount, {
      stakers: round.stakers || [],
      stakerShareBps: config.stakerShareBps ?? 5000,
      minStakerPrincipal: config.minStakerPrincipal ?? '50000000'
    });
    const totals = await this.totals();
    const updates = [];
    for (const member of Object.keys(split.perMember)) {
      const rec = await this.get('member/' + member);
      if (!rec) return false;
      let credit = this.protocol.safeBigInt(split.perMember[member]);
      if (split.perDividend[member]) credit += this.protocol.safeBigInt(split.perDividend[member]);
      rec.earnings = (this.protocol.safeBigInt(rec.earnings) + credit).toString();
      updates.push([member, rec]);
    }
    const credited = this.protocol.safeBigInt(this.value.amount) - this.protocol.safeBigInt(split.dust) - this.protocol.safeBigInt(split.operatorFee);
    totals.earningsOwed = (this.protocol.safeBigInt(totals.earningsOwed) + credited).toString();
    totals.feesAccrued = (this.protocol.safeBigInt(totals.feesAccrued) + this.protocol.safeBigInt(split.operatorFee)).toString();
    totals.dust = (this.protocol.safeBigInt(totals.dust) + this.protocol.safeBigInt(split.dust)).toString();
    round.settled = this.value.amount;
    round.fee = split.totalFee;
    round.fees = split.perFee;
    round.operatorFee = split.operatorFee;
    round.dividends = split.perDividend;
    round.dust = split.dust;
    for (const [member, rec] of updates) await this.put('member/' + member, rec);
    await this.put('totals', totals);
    await this.put(key, round);
  }

  async payoutRequest() {
    const { member, amount } = this.value;
    const rec = await this.get('member/' + member);
    if (!rec || rec.peer !== this.address) return false;
    const config = await this.cfg();
    const amt = this.amt(amount);
    // Earnings below minPayout keep accumulating in the ledger: paying them
    // out would cost more in TNK transfer fees than they are worth.
    if (config && amt < this.protocol.safeBigInt(config.minPayout)) return false;
    if (this.protocol.safeBigInt(rec.earnings) < amt) return false;
    const counters = await this.counters();
    counters.payout += 1;
    const id = 'po' + counters.payout;
    rec.earnings = (this.protocol.safeBigInt(rec.earnings) - amt).toString();
    const totals = await this.totals();
    totals.earningsOwed = (this.protocol.safeBigInt(totals.earningsOwed) - amt).toString();
    await this.put('payout/' + id, { member, amount, status: 'requested', txRef: null });
    await this.put('member/' + member, rec);
    await this.put('totals', totals);
    await this.put('counters', counters);
  }

  async payoutPaid() {
    const config = await this.cfg();
    if (!this.isOp(config)) return false;
    const key = 'payout/' + this.value.id;
    const po = await this.get(key);
    if (!po || po.status !== 'requested') return false;
    po.status = 'paid';
    po.txRef = this.value.txRef;
    await this.put(key, po);
  }

  async payoutCancel() {
    const config = await this.cfg();
    if (!this.isOp(config)) return false;
    const key = 'payout/' + this.value.id;
    const po = await this.get(key);
    if (!po || po.status !== 'requested') return false;
    const rec = await this.get('member/' + po.member);
    if (!rec) return false;
    rec.earnings = (this.protocol.safeBigInt(rec.earnings) + this.protocol.safeBigInt(po.amount)).toString();
    const totals = await this.totals();
    totals.earningsOwed = (this.protocol.safeBigInt(totals.earningsOwed) + this.protocol.safeBigInt(po.amount)).toString();
    po.status = 'cancelled';
    await this.put(key, po);
    await this.put('member/' + po.member, rec);
    await this.put('totals', totals);
  }

  async exitRequest() {
    const { member, amount } = this.value;
    const rec = await this.get('member/' + member);
    if (!rec || rec.peer !== this.address) return false;
    const config = await this.cfg();
    const amt = this.amt(amount);
    // Same floor as a deposit: without it a member can create unlimited
    // one-unit exit records and bloat the replicated state.
    if (config && amt < this.protocol.safeBigInt(config.minDeposit)) return false;
    if (this.protocol.safeBigInt(rec.principal) < amt) return false;
    const counters = await this.counters();
    counters.exit += 1;
    const id = 'ex' + counters.exit;
    rec.principal = (this.protocol.safeBigInt(rec.principal) - amt).toString();
    rec.exiting = (this.protocol.safeBigInt(rec.exiting) + amt).toString();
    const totals = await this.totals();
    totals.principal = (this.protocol.safeBigInt(totals.principal) - amt).toString();
    await this.put('exit/' + id, { member, amount, status: 'requested', txRef: null });
    await this.put('member/' + member, rec);
    await this.put('totals', totals);
    await this.put('counters', counters);
  }

  async exitPaid() {
    const config = await this.cfg();
    if (!this.isOp(config)) return false;
    const key = 'exit/' + this.value.id;
    const ex = await this.get(key);
    if (!ex || ex.status !== 'requested') return false;
    const rec = await this.get('member/' + ex.member);
    if (!rec) return false;
    rec.exiting = (this.protocol.safeBigInt(rec.exiting) - this.protocol.safeBigInt(ex.amount)).toString();
    ex.status = 'paid';
    ex.txRef = this.value.txRef;
    await this.put(key, ex);
    await this.put('member/' + ex.member, rec);
  }

  // Sweep accrued fees to the ONE configured feeReceiver. There is no receiver
  // argument: the destination cannot be chosen by the caller, so a
  // compromised operator key cannot redirect fees elsewhere without changing
  // the config, which has no setter.
  async feeSweep() {
    const config = await this.cfg();
    if (!this.isOp(config)) return false;
    if (!config.feeReceiverLocked || !config.feeReceiver) return false;
    if (await this.get('sweep/' + this.value.txRef)) return false;
    const totals = await this.totals();
    const amt = this.amt(this.value.amount);
    const outstanding = this.protocol.safeBigInt(totals.feesAccrued) - this.protocol.safeBigInt(totals.feesSwept);
    if (amt > outstanding) return false;
    totals.feesSwept = (this.protocol.safeBigInt(totals.feesSwept) + amt).toString();
    await this.put('sweep/' + this.value.txRef, { amount: this.value.amount, feeReceiver: config.feeReceiver });
    await this.put('totals', totals);
  }

  // Only the rounding remainder that no member was ever credited with.
  // Fees have their own counters and are not touchable here.
  async dustSweep() {
    const config = await this.cfg();
    if (!this.isOp(config)) return false;
    if (!config.feeReceiverLocked || !config.feeReceiver) return false;
    if (await this.get('sweep/' + this.value.txRef)) return false;
    const totals = await this.totals();
    const amt = this.amt(this.value.amount);
    if (amt > this.protocol.safeBigInt(totals.dust)) return false;
    totals.dust = (this.protocol.safeBigInt(totals.dust) - amt).toString();
    await this.put('sweep/' + this.value.txRef, { amount: this.value.amount, feeReceiver: config.feeReceiver, dust: true });
    await this.put('totals', totals);
  }

  // Read-only solvency check: does the pool wallet actually hold what the
  // ledger says it owes? `onchain` is the balance the operator reads from the
  // gateway; this function only compares and reports, it never moves funds.
  async solvencyRead() {
    const totals = await this.totals();
    const owedPrincipal = this.protocol.safeBigInt(totals.principal);
    const owedEarnings = this.protocol.safeBigInt(totals.earningsOwed);
    const unswept = this.protocol.safeBigInt(totals.feesAccrued) - this.protocol.safeBigInt(totals.feesSwept);
    const owed = owedPrincipal + owedEarnings + unswept + this.protocol.safeBigInt(totals.dust);
    const onchain = this.protocol.safeBigInt(this.value.onchain);
    console.log('solvency:', {
      owed: owed.toString(), onchain: onchain === null ? 'invalid' : onchain.toString(),
      principal: owedPrincipal.toString(), earnings: owedEarnings.toString(),
      feesUnswept: unswept.toString(), dust: totals.dust,
      ok: onchain !== null && onchain >= owed
    });
  }

  async memberRead() {
    const rec = await this.get('member/' + this.value.member);
    console.log('member ' + this.value.member + ':', rec);
  }

  async poolRead() {
    const config = await this.cfg();
    const totals = await this.totals();
    const members = (await this.get('members')) || [];
    console.log('pool config (immutable after init):', config);
    console.log('pool member fee tiers:', MEMBER_FEE_TIERS);
    if (config) {
      const stakerList = [];
      for (const m of members) {
        const rec = await this.get('member/' + m);
        if (rec && rec.staker === true) stakerList.push(m);
      }
      console.log('pool stakers (share bps ' + (config.stakerShareBps ?? 5000) + ', min principal ' + (config.minStakerPrincipal ?? '50000000') + '):', stakerList);
      const outstanding = this.protocol.safeBigInt(totals.feesAccrued) - this.protocol.safeBigInt(totals.feesSwept);
      console.log('pool fee receiver:', { receiver: config.feeReceiver ?? '(unset)', locked: config.feeReceiverLocked === true, outstanding: outstanding.toString() });
    }
    console.log('pool totals:', totals);
    console.log('pool members:', members.length);
  }
}

export default PoolContract;
