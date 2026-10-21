import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSplit, feeForMember, MEMBER_FEE_BPS } from '../contract/split.mjs';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const sum = (obj) => Object.values(obj).reduce((a, v) => a + BigInt(v), 0n);

test('member fee tiers by own principal, thresholds inclusive', () => {
  assert.equal(MEMBER_FEE_BPS, 1000);             // ceiling is 10%
  assert.equal(feeForMember('0'), 1000);          // nothing -> 10%
  assert.equal(feeForMember('100000'), 1000);     // 0.001 RESET -> 10%
  assert.equal(feeForMember('5000000'), 1000);    // 0.05 RESET -> 10%
  assert.equal(feeForMember('99999999'), 1000);
  assert.equal(feeForMember('100000000'), 500);   // exactly 1 RESET -> 5%
  assert.equal(feeForMember('499999999'), 500);
  assert.equal(feeForMember('500000000'), 200);   // exactly 5 RESET -> 2%
  assert.equal(feeForMember('1999999999'), 200);
  assert.equal(feeForMember('2000000000'), 0);    // exactly 20 RESET -> 0%
  assert.equal(feeForMember('99900000000'), 0);
});

test('two small members, both 10 percent', () => {
  const s = computeSplit({ [A]: '60', [B]: '40' }, '1000');
  assert.equal(s.perMember[A], '540');  // gross 600, fee 60
  assert.equal(s.perMember[B], '360');  // gross 400, fee 40
  assert.equal(s.totalFee, '100');
  assert.equal(s.dust, '0');
  assert.equal(sum(s.perMember) + BigInt(s.totalFee) + BigInt(s.dust), 1000n);
});

test('whale at 0 percent next to a small member at 10 percent', () => {
  // A: 25 RESET principal, B: 0.05 RESET, round payout 0.001 RESET (100000 units)
  const s = computeSplit({ [A]: '2500000000', [B]: '5000000' }, '100000');
  assert.equal(s.perFee[A], '0');        // whale pays nothing
  assert.equal(s.perMember[A], '99800'); // full gross share
  assert.equal(s.perMember[B], '180');   // gross 199, fee 19
  assert.equal(s.perFee[B], '19');
  assert.equal(s.totalFee, '19');
  assert.equal(sum(s.perMember) + BigInt(s.totalFee) + BigInt(s.dust), 100000n);
});

test('mid-tier member at 2 percent', () => {
  const s = computeSplit({ [A]: '500000000', [B]: '500000000' }, '10000');
  // both 5 RESET principals: gross 5000 each, fee 2% = 100, net 4900
  assert.equal(s.perMember[A], '4900');
  assert.equal(s.perMember[B], '4900');
  assert.equal(s.totalFee, '200');
});

test('rounding dust stays in pool, totals always conserve', () => {
  const s = computeSplit({ [A]: '1', [B]: '1', [C]: '1' }, '101');
  assert.equal(sum(s.perMember) + BigInt(s.totalFee) + BigInt(s.dust), 101n);
  assert.ok(BigInt(s.dust) >= 0n);
});

test('micro member at the 0.001 threshold still gets exact pro-rata', () => {
  // A: 0.001 RESET (the minimum join), B: 25 RESET, payout 100000 units
  const s = computeSplit({ [A]: '100000', [B]: '2500000000' }, '100000');
  assert.equal(s.perMember[A], '3'); // gross floor(3.99) = 3, 10% fee floors to 0
  assert.equal(s.perFee[A], '0');
  assert.equal(sum(s.perMember) + BigInt(s.totalFee) + BigInt(s.dust), 100000n);
});

test('empty snapshot: nothing distributed, everything is dust', () => {
  const s = computeSplit({}, '1000');
  assert.deepEqual(s.perMember, {});
  assert.equal(s.totalFee, '0');
  assert.equal(s.dust, '1000');
});

const conserves = (s, amount) =>
  sum(s.perMember) + sum(s.perDividend) + BigInt(s.operatorFee) + BigInt(s.dust) === BigInt(amount);

test('staker pays no fee and takes half the collected fees as dividend', () => {
  // A: staker, 0.2 RESET. B: member, 0.8 RESET (10% tier). Payout 100000.
  const s = computeSplit({ [A]: '20000000', [B]: '80000000' }, '100000',
    { stakers: [A], stakerShareBps: 5000, minStakerPrincipal: '10000000' });
  assert.equal(s.perMember[A], '20000');  // full gross, zero fee
  assert.equal(s.perFee[A], '0');
  assert.equal(s.perMember[B], '72000');  // gross 80000, fee 8000
  assert.equal(s.totalFee, '8000');
  assert.equal(s.perDividend[A], '4000'); // 50% of the 8000 fee
  assert.equal(s.operatorFee, '4000');    // operator keeps the other half
  assert.ok(conserves(s, '100000'));
});

test('two stakers split the dividend pro-rata by principal', () => {
  // A staker 0.3, C staker 0.1, B member 0.6 (10%). Payout 100000.
  const s = computeSplit({ [A]: '30000000', [B]: '60000000', [C]: '10000000' }, '100000',
    { stakers: [A, C], stakerShareBps: 5000, minStakerPrincipal: '10000000' });
  assert.equal(s.totalFee, '6000');       // only B pays
  assert.equal(s.perDividend[A], '2250'); // 3000 pool, 3:1 split
  assert.equal(s.perDividend[C], '750');
  assert.equal(s.operatorFee, '3000');
  assert.ok(conserves(s, '100000'));
});

test('flagged member below the staker minimum is a normal member that round', () => {
  // A flagged but only 0.05 RESET principal (< 0.1 minimum): pays 10%, no dividend.
  const s = computeSplit({ [A]: '5000000', [B]: '95000000' }, '100000',
    { stakers: [A], stakerShareBps: 5000, minStakerPrincipal: '10000000' });
  assert.equal(s.perFee[A], '500');       // gross 5000, 10% fee
  assert.equal(s.perDividend[A], undefined);
  assert.equal(s.operatorFee, s.totalFee); // nobody active: operator keeps all fees
  assert.ok(conserves(s, '100000'));
});

test('staker share of zero disables dividends, share of 100 percent leaves operator only rounding', () => {
  const snap = { [A]: '20000000', [B]: '80000000' };
  const s0 = computeSplit(snap, '100000', { stakers: [A], stakerShareBps: 0, minStakerPrincipal: '10000000' });
  assert.deepEqual(s0.perDividend, {});
  assert.equal(s0.operatorFee, '8000');
  const s100 = computeSplit(snap, '99999', { stakers: [A], stakerShareBps: 10000, minStakerPrincipal: '10000000' });
  assert.equal(BigInt(s100.operatorFee) + BigInt(s100.totalDividend), BigInt(s100.totalFee));
  assert.ok(BigInt(s100.totalDividend) > 0n);
  assert.ok(conserves(s100, '99999'));
});

test('legacy call without staker options: no dividends, operator keeps every fee', () => {
  const s = computeSplit({ [A]: '20000000', [B]: '80000000' }, '100000');
  assert.deepEqual(s.perDividend, {});
  assert.equal(s.totalDividend, '0');
  assert.equal(s.operatorFee, s.totalFee);
});

test('property: 500 random rounds with random stakers conserve and respect the rules', () => {
  let seed = 123456789;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const pool = [A, B, C, 'd'.repeat(64), 'e'.repeat(64), 'f'.repeat(64)];
  for (let i = 0; i < 500; i++) {
    const n = 1 + rnd(6);
    const snap = {};
    const stakers = [];
    for (let j = 0; j < n; j++) {
      snap[pool[j]] = String(1 + rnd(3000000000));
      if (rnd(2)) stakers.push(pool[j]);
    }
    const amount = String(1 + rnd(10000000));
    const s = computeSplit(snap, amount,
      { stakers, stakerShareBps: rnd(10001), minStakerPrincipal: '10000000' });
    assert.ok(conserves(s, amount), 'conservation failed at iter ' + i);
    assert.equal(BigInt(s.operatorFee) + BigInt(s.totalDividend), BigInt(s.totalFee));
    const total = Object.values(snap).reduce((a, v) => a + BigInt(v), 0n);
    for (const addr of Object.keys(snap)) {
      const p = BigInt(snap[addr]);
      const gross = (BigInt(amount) * p) / total;
      const active = stakers.includes(addr) && p >= 10000000n;
      if (active) {
        assert.equal(s.perFee[addr], '0');
        assert.equal(s.perMember[addr], gross.toString());
      } else {
        assert.equal(BigInt(s.perFee[addr]), (gross * BigInt(feeForMember(p))) / 10000n);
        assert.equal(s.perDividend[addr], undefined);
      }
    }
  }
});

test('a full round payout is accounted for exactly once', () => {
  const s = computeSplit({ [A]: '20000000', [B]: '80000000' }, '100000');
  // both principals sit below 1 RESET, so both pay the 10% tier
  assert.equal(s.operatorFee, '10000');
  assert.equal(sum(s.perMember) + sum(s.perDividend) + BigInt(s.operatorFee) + BigInt(s.dust), 100000n);
});

test('fee ceiling holds for every principal below the first threshold', () => {
  for (const p of ['0', '1', '100000', '1000000', '5000000', '99999999']) {
    assert.equal(feeForMember(p), 1000, `expected 10% at principal ${p}`);
  }
});
