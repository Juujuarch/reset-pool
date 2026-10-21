// Pure settlement split math for the RESET mining pool.
// No imports on purpose: unit-tested standalone (tests/pool-split.test.mjs)
// and imported by contract.js. All amounts are integer base units given as
// decimal strings. RESET has 8 decimals, but the math is unit-agnostic.
//
// PER-MEMBER tiered fee. Each member's rate depends on THEIR OWN principal in
// the round snapshot, not on the pool total. Rationale: fair share is strictly
// pro-rata, so any fee makes a large depositor worse off than perfect solo
// mining. Big depositors need a near-zero rate or nobody with size will join.
//
// Schedule as published in the original design: 10 / 5 / 2 / 0.
export const MEMBER_FEE_BPS = 1000;         // ceiling: 10.00%

export const MEMBER_FEE_TIERS = [
  { minPrincipal: '2000000000', bps: 0 },     // >= 20 RESET -> 0%
  { minPrincipal: '500000000', bps: 200 },    // >= 5 RESET  -> 2%
  { minPrincipal: '100000000', bps: 500 },    // >= 1 RESET  -> 5%
  { minPrincipal: '0', bps: 1000 }            // below 1 RESET -> 10%
];

export function feeForMember(principalUnits) {
  const p = BigInt(principalUnits || '0');
  for (const tier of MEMBER_FEE_TIERS) {
    if (p >= BigInt(tier.minPrincipal)) return tier.bps;
  }
  return MEMBER_FEE_BPS;
}

// snapshot: { memberHex: principalUnitsString, ... } (frozen at round claim)
// amountUnits: settled payout for the round, as a string
// stakerOpts (optional): { stakers: [memberHex, ...] flagged at snapshot
// time, stakerShareBps, minStakerPrincipal }. A flagged member whose
// snapshot principal reaches minStakerPrincipal is an ACTIVE staker for
// the round: pays no fee on their own earnings, and shares the round's
// collected fees with the operator. The fee total is split: stakers get
// stakerShareBps of it, pro-rata by their snapshot principal (floored);
// the operator keeps the rest, including dividend rounding remainders.
//
// Each member's gross share is floored pro-rata; their fee is floored from
// their own tier rate; net = gross - fee. Staker dividends are a REDISTRIBUTION
// of collected fees: a non-staker never loses more than their own fee
// (net >= gross - own fee), the staker dividend pool never exceeds
// stakerShareBps of feeTotal, and conservation always holds:
// sum(net) + sum(dividends) + operatorFee + dust == amountUnits.
// Dust (gross rounding) stays in the pool. With no stakerOpts the result
// is the legacy split (operatorFee == totalFee, no dividends).
export function computeSplit(snapshot, amountUnits, stakerOpts = null) {
  const amount = BigInt(amountUnits);
  const total = Object.values(snapshot || {}).reduce((acc, v) => acc + BigInt(v), 0n);
  let shareBps = 0n;
  let minStaker = 0n;
  const flagged = new Set();
  if (stakerOpts) {
    shareBps = BigInt(stakerOpts.stakerShareBps ?? 5000);
    if (shareBps < 0n) shareBps = 0n;
    if (shareBps > 10000n) shareBps = 10000n;
    minStaker = BigInt(stakerOpts.minStakerPrincipal ?? '50000000');
    for (const addr of stakerOpts.stakers || []) flagged.add(addr);
  }
  const isActiveStaker = (addr, principal) =>
    flagged.has(addr) && principal >= minStaker && minStaker > 0n;
  const perMember = {};
  const perFee = {};
  const perDividend = {};
  let grossAssigned = 0n;
  let feeTotal = 0n;
  let stakerTotal = 0n;
  if (total > 0n) {
    for (const addr of Object.keys(snapshot).sort()) {
      const principal = BigInt(snapshot[addr]);
      const gross = (amount * principal) / total;
      const active = isActiveStaker(addr, principal);
      const fee = active ? 0n : (gross * BigInt(feeForMember(principal))) / 10000n;
      perMember[addr] = (gross - fee).toString();
      perFee[addr] = fee.toString();
      grossAssigned += gross;
      feeTotal += fee;
      if (active) stakerTotal += principal;
    }
  }
  let totalDividend = 0n;
  if (feeTotal > 0n && shareBps > 0n && stakerTotal > 0n) {
    const stakerPool = (feeTotal * shareBps) / 10000n;
    if (stakerPool > 0n) {
      for (const addr of Object.keys(snapshot).sort()) {
        const principal = BigInt(snapshot[addr]);
        if (!isActiveStaker(addr, principal)) continue;
        const div = (stakerPool * principal) / stakerTotal;
        if (div > 0n) {
          perDividend[addr] = div.toString();
          totalDividend += div;
        }
      }
    }
  }
  return {
    perMember,
    perFee,
    perDividend,
    totalFee: feeTotal.toString(),
    operatorFee: (feeTotal - totalDividend).toString(),
    totalDividend: totalDividend.toString(),
    dust: (amount - grossAssigned).toString(),
    totalPrincipal: total.toString()
  };
}
