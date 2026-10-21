// RESET mining pool ledger contract.
//
// Immutable: every parameter is written once at pool_init and there is no
// operation anywhere that changes it afterwards.
//
// The contract is the accounting layer. The operator runs a claim loop
// against the RESET gateway; this ledger records who deposited how much,
// what each round settled, and what each member is owed — replicated to
// every member peer so the numbers are auditable by all.

import { Contract } from 'trac-peer';
import { computeSplit, MEMBER_FEE_TIERS } from './split.mjs';

const ADDR = { type: 'string', pattern: /^[0-9a-f]{64}$/ };
const AMOUNT = { type: 'string', pattern: /^[0-9]{1,24}$/ };
const TXREF = { type: 'string', min: 1, max: 128 };
const ROUND = { type: 'number', integer: true, min: 0 };

class PoolContract extends Contract {
  constructor(protocol, options = {}) {
    super(protocol, options);

    const FEE_RECV = { type: 'array', min: 1, max: 4,
      items: { $$strict: true, $$type: 'object', address: ADDR, bps: { type: 'number', integer: true, min: 0, max: 10000 } } };
    this.addSchema('poolInit', { value: { $$strict: true, $$type: 'object',
      poolWallet: ADDR, feeReceivers: FEE_RECV } });
    this.addSchema('setFeeReceivers', { value: { $$strict: true, $$type: 'object',
      feeReceivers: FEE_RECV } });
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

  // ─── read helpers ────────────────────────────────────────────────────────

  async cfg() { return await this.get('config'); }
  async totals() {
    return await this.get('totals') ||
      { principal: '0', earningsOwed: '0', feesAccrued: '0', feesSwept: '0', dust: '0' };
  }
  async counters() { return await this.get('counters') || { payout: 0, exit: 0 }; }
  isOp(config) { return config && this.address === config.operator; }
  amt(x) {
    const b = this.protocol.safeBigInt(x);
    this.assert(b !== null && b > 0n, new Error('bad amount'));
    return b;
  }

  // Splits a fee amount across the configured receivers, largest-remainder
  // method, conserving every unit: sum(parts) == amount.
  static splitFee(feeReceivers, amountUnits, protocol) {
    const amount = protocol.safeBigInt(amountUnits);
    const totalBps = feeReceivers.reduce((a, r) => a + r.bps, 0);
    if (totalBps !== 10000) return null;
    const parts = [];
    let assigned = 0n;
    for (const r of feeReceivers) {
      const raw = amount * BigInt(r.bps);
      const floor = raw / 10000n;
      parts.push({ address: r.address, bps: r.bps, floor, remainder: raw % 10000n });
      assigned += floor;
    }
    let leftover = amount - assigned;
    parts.sort((a, b) => (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : 0));
    for (const p of parts) { if (leftover > 0n) { p.amount = p.floor + 1n; leftover -= 1n; } else p.amount = p.floor; }
    return parts.map(p => ({ address: p.address, amount: p.amount.toString() }));
  }

  // ─── init (one-shot) ─────────────────────────────────────────────────────

  // pool_init must be sent by the operator in the same transaction that
  // deploys the contract, or an attacker can front-run it and become
  // the operator.
  async poolInit() {
    if (await this.get('config')) return false;
    const feeReceivers = this.value.feeReceivers ?? null;
    if (feeReceivers) {
      if (feeReceivers.reduce((a, r) => a + r.bps, 0) !== 10000) return false;
      if (feeReceivers.some(r => r.address === this.value.poolWallet)) return false;
      const seen = new Set();
      for (const r of feeReceivers) { if (seen.has(r.address)) return false; seen.add(r.address); }
    }
    const config = {
      operator: this.address,
      poolWallet: this.value.poolWallet,
      feeReceivers,                       // [{address, bps}] summing to 10000
      feeBps: 400,                     // 4% of earnings, frozen
      minDeposit: '100000',            // 0.001 RESET, frozen
      minPayout: '1000000',            // 0.01 RESET, frozen
      stakerShareBps: 5000,            // 50% of fees to stakers, frozen
      minStakerPrincipal: '50000000',  // 0.5 RESET, frozen
      feeMode: 'split-v6-immutable',
      feeReceiversLocked: feeReceivers !== null,
    };
    await this.put('config', config);
    await this.put('members', []);
    await this.put('totals', await this.totals());
    await this.put('counters', await this.counters());
  }

  // The fee receivers can be set exactly once, and only while still empty.
  // After that it is locked: there is no path to change it.
  async setFeeReceivers() {
    const config = await this.cfg();
    if (!this.isOp(config)) return false;
    if (config.feeReceiversLocked) return false;
    const frs = this.value.feeReceivers;
    if (frs.reduce((a, r) => a + r.bps, 0) !== 10000) return false;
    if (frs.some(r => r.address === config.poolWallet)) return false;
    const seen = new Set();
    for (const r of frs) { if (seen.has(r.address)) return false; seen.add(r.address); }
    config.feeReceivers = frs;
    config.feeReceiversLocked = true;
    await this.put('config', config);
  }

  // ─── member ──────────────────────────────────────────────────────────────

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

  // ─── operator: deposit ───────────────────────────────────────────────────

  async depositCredit() {
    const config = await this.cfg();
    if (!this.isOp(config)) return false;
    const { member, amount, txRef } = this.value;
    if (await this.get('deposit/' + txRef)) return false;
    const rec = await this.get('member/' + member);
    if (!rec) return false;
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

  // ─── operator: round lifecycle ───────────────────────────────────────────

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

  // ─── member: payouts and exits ───────────────────────────────────────────

  async payoutRequest() {
    const { member, amount } = this.value;
    const rec = await this.get('member/' + member);
    if (!rec || rec.peer !== this.address) return false;
    const config = await this.cfg();
    const amt = this.amt(amount);
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

  // ─── operator: fee and dust sweeps ───────────────────────────────────────

  async feeSweep() {
    const config = await this.cfg();
    if (!this.isOp(config)) return false;
    if (!config.feeReceiversLocked || !config.feeReceivers) return false;
    if (await this.get('sweep/' + this.value.txRef)) return false;
    const totals = await this.totals();
    const amt = this.amt(this.value.amount);
    const outstanding = this.protocol.safeBigInt(totals.feesAccrued) - this.protocol.safeBigInt(totals.feesSwept);
    if (amt > outstanding) return false;
    const parts = PoolContract.splitFee(config.feeReceivers, this.value.amount, this.protocol);
    if (!parts) return false;
    totals.feesSwept = (this.protocol.safeBigInt(totals.feesSwept) + amt).toString();
    await this.put('sweep/' + this.value.txRef, { amount: this.value.amount, parts });
    await this.put('totals', totals);
  }

  async dustSweep() {
    const config = await this.cfg();
    if (!this.isOp(config)) return false;
    if (!config.feeReceiversLocked || !config.feeReceivers) return false;
    if (await this.get('sweep/' + this.value.txRef)) return false;
    const totals = await this.totals();
    const amt = this.amt(this.value.amount);
    if (amt > this.protocol.safeBigInt(totals.dust)) return false;
    const parts = PoolContract.splitFee(config.feeReceivers, this.value.amount, this.protocol);
    if (!parts) return false;
    totals.dust = (this.protocol.safeBigInt(totals.dust) - amt).toString();
    await this.put('sweep/' + this.value.txRef, { amount: this.value.amount, parts, dust: true });
    await this.put('totals', totals);
  }

  // ─── read-only: solvency ─────────────────────────────────────────────────

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
      console.log('pool fee receivers:', { receivers: config.feeReceivers ?? '(unset)', locked: config.feeReceiversLocked === true, outstanding: outstanding.toString() });
    }
    console.log('pool totals:', totals);
    console.log('pool members:', members.length);
  }
}

export default PoolContract;
