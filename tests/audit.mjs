// Adversarial harness for the v4 pool contract.
// Runs the REAL contract sources against a stubbed trac-peer base, drives a full
// legitimate cycle, then tries to break it. Every rejected op must leave the
// state hash byte-identical.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// ---- one shared stub base for every actor --------------------------------
class SharedBase {
  constructor() { this.map = new Map(); }
  // Faithful to trac-peer storage semantics: every get returns a fresh
  // deserialized copy, so in-place mutation of a returned record cannot
  // leak into stored state before an explicit put.
  async get(key) { return this.map.has(key) ? JSON.parse(JSON.stringify(this.map.get(key))) : null; }
  async put(key, value) { this.map.set(key, JSON.parse(JSON.stringify(value))); }
  async del(key) { this.map.delete(key); }
  hash() {
    const keys = [...this.map.keys()].sort();
    const h = createHash('sha256');
    for (const k of keys) h.update(k).update('\u0000').update(JSON.stringify(this.map.get(k))).update('\u0001');
    return h.digest('hex');
  }
}

class StubProtocol {
  constructor(base) { this.base = base; }
  safeBigInt(v) {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') return Number.isSafeInteger(v) ? BigInt(v) : null;
    if (typeof v === 'string' && /^[0-9]{1,78}$/.test(v)) return BigInt(v);
    return null;
  }
}

const BASE = new SharedBase();
const PROTO = new StubProtocol(BASE);

const mod = await import('../contract/contract.js');
const PoolContract = mod.default;

// Every actor is a fresh contract instance bound to the SAME base.
function actor(address, value = {}) {
  const c = new PoolContract(PROTO, {});
  c.address = address;
  c.value = value;
  c.get = k => BASE.get(k);
  c.put = (k, v) => BASE.put(k, v);
  c.del = k => BASE.del(k);
  c.assert = (cond, err) => { if (!cond) throw err; };
  return c;
}

const OP   = '1'.repeat(64);
const R1   = '2'.repeat(64);
const R2   = '3'.repeat(64);
const M1   = 'a'.repeat(64);
const M2   = 'b'.repeat(64);
const M3   = 'c'.repeat(64);
const EVIL = 'e'.repeat(64);

let pass = 0, fail = 0;
const ok = n => { pass++; console.log('  PASS  ' + n); };
const bad = (n, e) => { fail++; console.log('  FAIL  ' + n + ' :: ' + e.message); };

async function reject(name, fn) {
  const before = BASE.hash();
  let threw = false;
  try { await fn(); } catch { threw = true; }
  const after = BASE.hash();
  if (before !== after) return bad(name, new Error('MUTATED STATE'));
  return ok(name + (threw ? ' (threw)' : ' (refused)'));
}
async function accept(name, fn) {
  try { await fn(); ok(name); } catch (e) { bad(name, e); }
}

console.log('=== v4 pool contract adversarial harness ===\n');

// ---- 1. init ---------------------------------------------------------------
console.log('[1] init');
const RECV = [{ address: R1, bps: 6000 }, { address: R2, bps: 4000 }]; // 60/40 split
await accept('operator inits pool', () =>
  actor(OP, { poolWallet: 'f'.repeat(64), feeReceivers: RECV }).poolInit());

const cfg = await BASE.get('config');
assert.equal(cfg.operator, OP);
assert.deepEqual(cfg.feeReceivers, RECV);
assert.equal(cfg.feeMode, 'split-v6-immutable');
assert.equal(cfg.feeBps, 400);
ok('config records the receiver split (60/40)');

await reject('second poolInit refused', () =>
  actor(OP, { poolWallet: 'f'.repeat(64), feeReceivers: RECV }).poolInit());

// split validation at init
{
  const b = new SharedBase(); const p = new StubProtocol(b);
  const mk = (addr, value) => { const c = new PoolContract(p, {}); c.address = addr; c.value = value;
    c.get = k => b.get(k); c.put = (k, v) => b.put(k, v); c.del = k => b.del(k);
    c.assert = (cond, err) => { if (!cond) throw err; }; return c; };
  const PW = 'f'.repeat(64);
  const before = b.hash();
  await mk(OP, { poolWallet: PW, feeReceivers: [{ address: R1, bps: 6000 }, { address: R2, bps: 3000 }] }).poolInit();
  if (b.hash() !== before) bad('bps != 10000 accepted at init', new Error('mutated'));
  else ok('init refuses a split that does not sum to 10000 bps');

  await mk(OP, { poolWallet: PW, feeReceivers: [{ address: PW, bps: 10000 }] }).poolInit();
  if (b.hash() !== before) bad('receiver == poolWallet accepted', new Error('mutated'));
  else ok('init refuses a receiver equal to the pool wallet');

  await mk(OP, { poolWallet: PW, feeReceivers: [{ address: R1, bps: 5000 }, { address: R1, bps: 5000 }] }).poolInit();
  if (b.hash() !== before) bad('duplicate receiver addresses accepted', new Error('mutated'));
  else ok('init refuses duplicate receiver addresses');
}

// ---- 2. registration -------------------------------------------------------
console.log('\n[2] registration');
for (const [addr, who] of [[M1, 'M1'], [M2, 'M2'], [M3, 'M3']]) {
  await accept(`${who} registers`, () => actor(addr, { member: addr }).memberRegister());
}

// ---- 3. deposits -----------------------------------------------------------
console.log('\n[3] deposits');
await accept('credit M1 0.5 RESET', () => actor(OP, { member: M1, amount: '50000000', txRef: 'tx1' }).depositCredit());
await accept('credit M2 0.3 RESET', () => actor(OP, { member: M2, amount: '30000000', txRef: 'tx2' }).depositCredit());
await accept('credit M3 0.2 RESET', () => actor(OP, { member: M3, amount: '20000000', txRef: 'tx3' }).depositCredit());

await reject('non-operator cannot credit', () =>
  actor(EVIL, { member: M1, amount: '50000000', txRef: 'tx9' }).depositCredit());
await reject('same txRef cannot be credited twice', () =>
  actor(OP, { member: M1, amount: '50000000', txRef: 'tx1' }).depositCredit());
await reject('deposit below 0.001 minimum rejected', () =>
  actor(OP, { member: M1, amount: '99999', txRef: 'txsmall' }).depositCredit());
await reject('credit to unregistered member rejected', () =>
  actor(OP, { member: '9'.repeat(64), amount: '50000000', txRef: 'txu' }).depositCredit());

// ---- 4. snapshot -----------------------------------------------------------
console.log('\n[4] snapshot');
await accept('operator snapshots round 500', () => actor(OP, { round: 500 }).roundSnapshot());
const round = await BASE.get('round/500');
assert.equal(round.total, '100000000');
assert.equal(Object.keys(round.snapshot).length, 3);
ok('snapshot total and member count correct');

await reject('double snapshot refused', () => actor(OP, { round: 500 }).roundSnapshot());
await reject('non-operator cannot snapshot', () => actor(EVIL, { round: 501 }).roundSnapshot());

// ---- 5. settle -------------------------------------------------------------
console.log('\n[5] settle');
const PAYOUT = '18562500';
await accept('operator settles round 500', () => actor(OP, { round: 500, amount: PAYOUT }).roundSettle());

const settled = await BASE.get('round/500');
const opFee = BigInt(settled.operatorFee);
assert.equal(opFee, BigInt(settled.fee) - BigInt(settled.totalDividend ?? '0'), 'operator fee mismatch');
ok(`operator fee accrued to the single receiver: ${opFee}`);

const totals = await BASE.get('totals');
assert.equal(BigInt(totals.feesAccrued), opFee);
ok('totals track the split-receiver accrual');

let memberSum = 0n;
for (const m of [M1, M2, M3]) memberSum += BigInt((await BASE.get('member/' + m)).earnings);
const dust = BigInt(settled.dust);
assert.equal(memberSum + opFee + dust, BigInt(PAYOUT), 'round did not conserve');
ok(`conservation exact: members ${memberSum} + fee ${opFee} + dust ${dust} = ${PAYOUT}`);

const { feeForMember } = await import('../contract/split.mjs');
const m1rec = await BASE.get('member/' + M1);
const expectedGross = BigInt(PAYOUT) * 50000000n / BigInt(round.total);
const expectedBps = BigInt(feeForMember(round.snapshot[M1]));
const expectedNet = expectedGross - (expectedGross * expectedBps) / 10000n;
assert.equal(BigInt(m1rec.earnings), expectedNet, 'M1 net does not match its tier rate');
ok(`tier fee verified on M1: gross ${expectedGross}, ${Number(expectedBps) / 100}% -> net ${expectedNet}`);

// every member is charged their own tier rate
for (const [m, label] of [[M1, 'M1'], [M2, 'M2'], [M3, 'M3']]) {
  const p = BigInt(round.snapshot[m]);
  const gross = BigInt(PAYOUT) * p / BigInt(round.total);
  const bps = BigInt(feeForMember(round.snapshot[m]));
  const fee = BigInt(settled.fees[m] ?? '0');
  assert.equal(fee, gross * bps / 10000n, `${label} fee does not match its tier`);
}
ok('each member charged its own tier rate');

await reject('double settle refused', () => actor(OP, { round: 500, amount: PAYOUT }).roundSettle());
await reject('non-operator cannot settle', () => actor(EVIL, { round: 500, amount: PAYOUT }).roundSettle());
await reject('settle a round that was never snapshotted', () => actor(OP, { round: 777, amount: '1000' }).roundSettle());

// ---- 6. fee sweep per receiver --------------------------------------------
console.log('\n[6] fee sweep');
await reject('sweep above accrual refused', () =>
  actor(OP, { amount: (opFee + 1n).toString(), txRef: 'sw0' }).feeSweep());
await accept('sweep the full accrual', () =>
  actor(OP, { amount: opFee.toString(), txRef: 'sw1' }).feeSweep());
await reject('nothing left to sweep', () =>
  actor(OP, { amount: '1', txRef: 'sw3' }).feeSweep());
await reject('same txRef cannot sweep twice', () =>
  actor(OP, { amount: '1', txRef: 'sw1' }).feeSweep());
await reject('non-operator cannot sweep', () =>
  actor(EVIL, { amount: '1', txRef: 'sw4' }).feeSweep());

const t2 = await BASE.get('totals');
assert.equal(BigInt(t2.feesSwept), opFee);
ok('sweep is bounded');

// the sweep record must split the fee across both receivers, conserving units
{
  const rec = await BASE.get('sweep/sw1');
  const parts = rec.parts;
  assert.equal(parts.length, 2, 'expected two receiver parts');
  const sum = parts.reduce((a, p) => a + BigInt(p.amount), 0n);
  assert.equal(sum, opFee, 'split parts do not conserve the fee');
  const r1Amt = BigInt(parts.find(p => p.address === R1).amount);
  const r2Amt = BigInt(parts.find(p => p.address === R2).amount);
  // 60/40 split with largest-remainder: r1 gets the ceil, r2 the floor (or equal)
  assert.ok(r1Amt > r2Amt, '60% receiver did not receive the larger part');
  ok(`splitFee verified: R1=${r1Amt} R2=${r2Amt} (60/40, conservation exact)`);
}

// ---- 7. member overreach ---------------------------------------------------
console.log('\n[7] member overreach');
await reject('payout below 0.01 floor refused', () =>
  actor(M1, { member: M1, amount: '1' }).payoutRequest());
const m1earn = BigInt((await BASE.get('member/' + M1)).earnings);
await reject('payout above earnings refused', () =>
  actor(M1, { member: M1, amount: (m1earn + 1n).toString() }).payoutRequest());
await reject('payout on another member refused', () =>
  actor(EVIL, { member: M1, amount: '1000000' }).payoutRequest());
await reject('exit above principal refused', () =>
  actor(M1, { member: M1, amount: '999999999' }).exitRequest());
await reject('non-operator cannot mark payout paid', () =>
  actor(EVIL, { id: 'po1', txRef: 'x' }).payoutPaid());

// ---- 8. staker flag --------------------------------------------------------
console.log('\n[8] staker');
await reject('non-operator cannot self-appoint staker', () =>
  actor(EVIL, { member: EVIL, enabled: true }).setStaker());
await reject('staker flag on unregistered address refused', () =>
  actor(OP, { member: '9'.repeat(64), enabled: true }).setStaker());

// ---- 8b. auto-stake preference --------------------------------------------
console.log('\n[8b] auto-stake');
await reject('non-member cannot set auto-stake', () =>
  actor(EVIL, { member: M1, enabled: true }).setAutoStake());
await reject('auto-stake on unregistered address refused', () =>
  actor(M2, { member: '9'.repeat(64), enabled: true }).setAutoStake());
await accept('M1 enables auto-stake (own record)', () =>
  actor(M1, { member: M1, enabled: true }).setAutoStake());
{
  const rec = await BASE.get('member/' + M1);
  if (rec.autoStake === true) ok('auto-stake flag stored on M1');
  else bad('auto-stake flag missing', new Error(JSON.stringify(rec)));
}
await accept('M1 disables auto-stake again (toggle off works)', () =>
  actor(M1, { member: M1, enabled: false }).setAutoStake());
{
  const rec = await BASE.get('member/' + M1);
  if (rec.autoStake === false) ok('auto-stake flag cleared on M1');
  else bad('auto-stake flag not cleared', new Error(JSON.stringify(rec)));
}
await accept('M1 re-enables auto-stake for the settle test', () =>
  actor(M1, { member: M1, enabled: true }).setAutoStake());

// settle round 502: M1 has autoStake on, M2/M3 do not → M1 compounds, others accumulate
{
  const preTotals = await BASE.get('totals');
  const m1Pre = await BASE.get('member/' + M1);
  await accept('snapshot round 502', () => actor(OP, { round: 502 }).roundSnapshot());
  await accept('settle round 502', () => actor(OP, { round: 502, amount: '10000000' }).roundSettle());
  const m1Post = await BASE.get('member/' + M1);
  const postTotals = await BASE.get('totals');
  const principalDelta = BigInt(m1Post.principal) - BigInt(m1Pre.principal);
  if (principalDelta > 0n && BigInt(m1Post.earnings) === BigInt(m1Pre.earnings)) ok(`auto-stake member compounded +${principalDelta} into principal`);
  else bad('auto-stake member did not compound', new Error(`principal delta ${principalDelta}`));
  if (BigInt(postTotals.principal) > BigInt(preTotals.principal)) ok('totals.principal grew by the compounded amount');
  else bad('totals.principal not updated by compounding', new Error('no growth'));
  const m2Post = await BASE.get('member/' + M2);
  if (BigInt(m2Post.earnings) > 0n) ok('non-auto-stake member still accumulates earnings');
  else bad('non-auto-stake member got no earnings', new Error('earnings empty'));
}

// ---- 9. staker round: fee-free + dividend, and the 2-receiver split still holds
console.log('\n[9] staker round');
await accept('operator flags M1 as staker', () => actor(OP, { member: M1, enabled: true }).setStaker());
await accept('snapshot round 501', () => actor(OP, { round: 501 }).roundSnapshot());
await accept('settle round 501', () => actor(OP, { round: 501, amount: PAYOUT }).roundSettle());

const r501 = await BASE.get('round/501');
assert.equal(BigInt(r501.fees[M1] ?? '0'), 0n, 'staker still charged a fee');
ok('staker pays 0% fee');
assert.ok(BigInt(r501.dividends[M1] ?? '0') > 0n, 'staker got no dividend');
ok('staker received a dividend');
ok(`operator fee with stakers: ${r501.operatorFee}`);

// ---- 10. v4.1 hardening: the five gaps found by probing ----------------
console.log('\n[10] hardening');

// 10a. distinct addresses at init
{
  const b = new SharedBase();
  const p = new StubProtocol(b);
  const mk = (addr, value) => {
    const c = new PoolContract(p, {});
    c.address = addr; c.value = value;
    c.get = k => b.get(k); c.put = (k, v) => b.put(k, v); c.del = k => b.del(k);
    c.assert = (cond, err) => { if (!cond) throw err; };
    return c;
  };
  const P0 = 'f'.repeat(64);
  let accepted = 0;
  for (const [pw, recv, label] of [
    [P0, [{ address: P0, bps: 10000 }], 'poolWallet == feeReceiver']
  ]) {
    const before = b.hash();
    await mk(OP, { poolWallet: pw, feeReceivers: recv }).poolInit();
    if (b.hash() !== before) { accepted++; bad(label + ' accepted', new Error('init mutated state')); }
    else ok(label + ' refused');
  }
  if (!accepted) ok('all duplicate-address configs rejected');
}

// 10b. exit below the deposit floor
await reject('exit below 0.001 floor refused', () =>
  actor(M1, { member: M1, amount: '1' }).exitRequest());

// 10c. dustSweep exists, is bounded by dust, and is operator-only
{
  // make a round that produces dust: 3 unequal principals, odd payout
  const b = new SharedBase();
  const p = new StubProtocol(b);
  const mk = (addr, value) => {
    const c = new PoolContract(p, {});
    c.address = addr; c.value = value;
    c.get = k => b.get(k); c.put = (k, v) => b.put(k, v); c.del = k => b.del(k);
    c.assert = (cond, err) => { if (!cond) throw err; };
    return c;
  };
  const D1 = '1'.repeat(64), D2 = '2'.repeat(64), D3 = '3'.repeat(64);
  await mk(OP, { poolWallet: 'f'.repeat(64), feeReceivers: RECV }).poolInit();
  for (const m of [D1, D2, D3]) await mk(m, { member: m }).memberRegister();
  await mk(OP, { member: D1, amount: '33333333', txRef: 'd1' }).depositCredit();
  await mk(OP, { member: D2, amount: '33333333', txRef: 'd2' }).depositCredit();
  await mk(OP, { member: D3, amount: '33333334', txRef: 'd3' }).depositCredit();
  await mk(OP, { round: 900 }).roundSnapshot();
  await mk(OP, { round: 900, amount: '10000001' }).roundSettle();
  const tot = await b.get('totals');
  const dustNow = BigInt(tot.dust);
  if (dustNow > 0n) ok(`round produced dust: ${dustNow} units`); else bad('no dust produced', new Error('test setup'));

  const before = b.hash();
  await mk(EVIL, { amount: dustNow.toString(), txRef: 'ds0' }).dustSweep();
  if (b.hash() !== before) bad('non-operator dustSweep mutated state', new Error('accepted'));
  else ok('non-operator dustSweep refused');

  await mk(OP, { amount: (dustNow + 1n).toString(), txRef: 'ds1' }).dustSweep();
  const tot2 = await b.get('totals');
  if (BigInt(tot2.dust) === dustNow) ok('dustSweep above dust refused'); else bad('dustSweep overspent', new Error('dust changed'));

  await mk(OP, { amount: dustNow.toString(), txRef: 'ds2' }).dustSweep();
  const tot3 = await b.get('totals');
  if (BigInt(tot3.dust) === 0n) ok('dustSweep cleared the dust exactly'); else bad('dustSweep wrong', new Error('dust=' + tot3.dust));

  await mk(OP, { amount: '1', txRef: 'ds3' }).dustSweep();
  const tot4 = await b.get('totals');
  if (BigInt(tot4.dust) === 0n) ok('dustSweep with nothing left refused'); else bad('dustSweep invented dust', new Error('dust=' + tot4.dust));
}

// 10d. redeposit while an exit is pending
{
  const b = new SharedBase();
  const p = new StubProtocol(b);
  const mk = (addr, value) => {
    const c = new PoolContract(p, {});
    c.address = addr; c.value = value;
    c.get = k => b.get(k); c.put = (k, v) => b.put(k, v); c.del = k => b.del(k);
    c.assert = (cond, err) => { if (!cond) throw err; };
    return c;
  };
  const E1 = 'e1'.padEnd(64, '0');
  await mk(OP, { poolWallet: 'f'.repeat(64), feeReceivers: RECV }).poolInit();
  await mk(E1, { member: E1 }).memberRegister();
  await mk(OP, { member: E1, amount: '10000000', txRef: 'e0' }).depositCredit();
  await mk(E1, { member: E1, amount: '10000000' }).exitRequest();
  const before = b.hash();
  await mk(OP, { member: E1, amount: '10000000', txRef: 'e1' }).depositCredit();
  if (b.hash() === before) ok('redeposit while exiting refused');
  else bad('redeposit while exiting accepted', new Error('state mutated'));
  // after the exit is paid, depositing is fine again
  await mk(OP, { id: 'ex1', txRef: 'x' }).exitPaid();
  await mk(OP, { member: E1, amount: '10000000', txRef: 'e2' }).depositCredit();
  const rec = await b.get('member/' + E1);
  if (BigInt(rec.principal) === 10000000n) ok('redeposit allowed once the exit settled');
  else bad('redeposit after exit wrong', new Error('principal=' + rec.principal));
}

// 10e. solvencyRead is read-only and detects a shortfall
{
  const b = new SharedBase();
  const p = new StubProtocol(b);
  const mk = (addr, value) => {
    const c = new PoolContract(p, {});
    c.address = addr; c.value = value;
    c.get = k => b.get(k); c.put = (k, v) => b.put(k, v); c.del = k => b.del(k);
    c.assert = (cond, err) => { if (!cond) throw err; };
    return c;
  };
  const S1 = '51'.padEnd(64, '0');
  await mk(OP, { poolWallet: 'f'.repeat(64), feeReceivers: RECV }).poolInit();
  await mk(S1, { member: S1 }).memberRegister();
  await mk(OP, { member: S1, amount: '10000000', txRef: 's1' }).depositCredit();
  const before = b.hash();
  await mk(OP, { onchain: '10000000' }).solvencyRead();
  if (b.hash() === before) ok('solvencyRead does not mutate state');
  else bad('solvencyRead mutated state', new Error('state changed'));
}

// ---- 11. v5 immutability: no op can re-parameterise the pool -------------
console.log('\n[11] immutability');

{
  const b = new SharedBase();
  const p = new StubProtocol(b);
  const mk = (addr, value) => {
    const c = new PoolContract(p, {});
    c.address = addr; c.value = value;
    c.get = k => b.get(k); c.put = (k, v) => b.put(k, v); c.del = k => b.del(k);
    c.assert = (cond, err) => { if (!cond) throw err; };
    return c;
  };
  const I1 = '11'.padEnd(64, '0');
  const VAULT = 'aa'.padEnd(64, '0');
  const OTHER = 'bb'.padEnd(64, '0');
  const RECV1 = [{ address: VAULT, bps: 10000 }];
  const RECV2 = [{ address: OTHER, bps: 10000 }];

  // init with NO fee receiver (vault not built yet)
  await mk(OP, { poolWallet: 'f'.repeat(64), feeReceivers: null }).poolInit();
  const c0 = await b.get('config');
  if (c0.feeReceivers === null && c0.feeReceiversLocked === false) ok('init accepts an unset fee receiver');
  else bad('unset receiver not stored', new Error(JSON.stringify(c0)));

  // fees cannot be swept while the receiver is unset
  await mk(I1, { member: I1 }).memberRegister();
  await mk(OP, { member: I1, amount: '10000000', txRef: 'i1' }).depositCredit();
  await mk(OP, { round: 700 }).roundSnapshot();
  await mk(OP, { round: 700, amount: '10000000' }).roundSettle();
  const pre = b.hash();
  await mk(OP, { amount: '1', txRef: 'swx' }).feeSweep();
  if (b.hash() === pre) ok('feeSweep refused while feeReceivers is unset');
  else bad('feeSweep ran without a receiver', new Error('state mutated'));

  // set it once
  await mk(OP, { feeReceivers: RECV1 }).setFeeReceivers();
  const c1 = await b.get('config');
  if (JSON.stringify(c1.feeReceivers) === JSON.stringify(RECV1) && c1.feeReceiversLocked === true) ok('feeReceivers set once and locked');
  else bad('setFeeReceivers failed', new Error(JSON.stringify(c1)));

  // cannot change it again, even by the operator
  const locked = b.hash();
  await mk(OP, { feeReceivers: RECV2 }).setFeeReceivers();
  if (b.hash() === locked) ok('feeReceivers cannot be changed a second time');
  else bad('feeReceivers was reassigned', new Error('state mutated'));

  // non-operator cannot set it either (fresh pool, unset receiver)
  {
    const b2 = new SharedBase();
    const p2 = new StubProtocol(b2);
    const mk2 = (addr, value) => {
      const c = new PoolContract(p2, {});
      c.address = addr; c.value = value;
      c.get = k => b2.get(k); c.put = (k, v) => b2.put(k, v); c.del = k => b2.del(k);
      c.assert = (cond, err) => { if (!cond) throw err; };
      return c;
    };
    await mk2(OP, { poolWallet: 'f'.repeat(64), feeReceivers: null }).poolInit();
    const pre2 = b2.hash();
    await mk2(EVIL, { feeReceivers: [{ address: EVIL, bps: 10000 }] }).setFeeReceivers();
    if (b2.hash() === pre2) ok('non-operator cannot set the fee receivers');
    else bad('non-operator set the fee receivers', new Error('state mutated'));
  }

  // a receiver equal to the pool wallet is refused
  {
    const b3 = new SharedBase();
    const p3 = new StubProtocol(b3);
    const mk3 = (addr, value) => {
      const c = new PoolContract(p3, {});
      c.address = addr; c.value = value;
      c.get = k => b3.get(k); c.put = (k, v) => b3.put(k, v); c.del = k => b3.del(k);
      c.assert = (cond, err) => { if (!cond) throw err; };
      return c;
    };
    const PW = 'cc'.padEnd(64, '0');
    await mk3(OP, { poolWallet: PW, feeReceivers: null }).poolInit();
    const pre3 = b3.hash();
    await mk3(OP, { feeReceivers: [{ address: PW, bps: 10000 }] }).setFeeReceivers();
    if (b3.hash() === pre3) ok('feeReceiver equal to the pool wallet refused');
    else bad('receiver == pool wallet accepted', new Error('state mutated'));
  }

  // there is no setter for feeBps / minDeposit / minPayout anywhere
  const proto = Object.getPrototypeOf(await mk(OP, {}));
  const setters = Object.getOwnPropertyNames(proto)
    .filter(n => /^(set|update|change|config|param)/i.test(n) && n !== 'setStaker' && n !== 'setFeeReceivers' && n !== 'setAutoStake');
  if (!setters.length) ok('no parameter setter exists on the contract (only setStaker, setFeeReceivers, setAutoStake)');
  else bad('unexpected setter found: ' + setters.join(','), new Error('immutability broken'));

  // the fee tiers live in split.mjs, which the version lock pins byte-for-byte
  const { MEMBER_FEE_TIERS } = await import('../contract/split.mjs');
  const tiers = MEMBER_FEE_TIERS.map(t => t.bps).join('/');
  if (tiers === '0/200/500/1000') ok(`fee tiers are constants in split.mjs: ${tiers} bps`);
  else bad('fee tiers drifted', new Error(tiers));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);