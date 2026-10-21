# Security Audit — v6

Pre-launch review of `contract/contract.js`, `contract/split.mjs`, and `contract/protocol.js`.

The pool was not live during this review, so every finding was free to fix.

---

## Method

Two independent test surfaces, both driving the **real contract sources** rather than a reimplementation.

**1. Adversarial harness** — `tests/audit.mjs`, 64 checks.

A complete legitimate cycle (init, three members register, three deposits credited, round snapshot, round settle at 0.185625 RESET, fee sweep, staker round) interleaved with attacks. Every refused operation must leave the state hash **byte-identical** — a rejection that still mutates state is a failure, not a pass.

**2. Unit tests** — `tests/pool-split.test.mjs`, 17 cases.

Settlement arithmetic in isolation, plus a 500-case randomized property sweep asserting exact conservation: `Σ member nets + dividends + operator fee + dust == payout`, with no member exceeding their gross pro-rata ceiling.

```sh
npm install
node --test tests/pool-split.test.mjs
node tests/audit.mjs
```

---

## Result

**No drain path found.** No operation lets an outsider or a member take funds that are not theirs. Fee sweeps split across up to 4 configured receivers by basis points (largest-remainder, conservation exact); the split is validated at init (must sum to 10000 bps, no duplicates, none equal to the pool wallet) and the receiver set is locked after being set once.

### Attacks refused

| Category | Attempts |
|---|---|
| **Privilege** | Non-operator calling `pool_init`, `deposit_credit`, `round_snapshot`, `round_settle`, `set_staker`, `set_auto_stake`, `set_fee_receivers`, `fee_sweep`, `dust_sweep`, `payout_paid`, `payout_cancel`, `exit_paid` |
| **Replay** | Second `pool_init`; double credit of one transfer reference; double snapshot; double settle; double sweep of one reference |
| **Member overreach** | Payout below the floor; payout above own earnings; payout against another member's record; exit above own principal; exit below the minimum; self-appointment as staker |
| **Operator overreach** | Settle a round never snapshotted; credit an unregistered member; credit below the minimum; staker flag on an unregistered address; sweep above accrued fees; dust sweep above accumulated dust; receiver split not summing to 10000 bps; duplicate receiver addresses; a receiver equal to the pool wallet |
| **Split integrity** | Second `set_fee_receivers` after lock; non-operator setting receivers; split parts failing conservation |

### Conservation

For the settled test round:

```
member nets  17,820,000
operator fee    742,500
dust                  0
─────────────────────────
total        18,562,500  =  payout
```

Every unit accounted for, once.

---

## Immutability

The contract is intentionally narrow: parameters are written once at `pool_init` and there is no operation that changes them afterwards.

**Verified by enumeration.** The harness walks the contract prototype and asserts that the only names matching `set|update|change|config|param` are `setStaker` and `setFeeReceiver`. `feeBps`, `minDeposit`, `minPayout`, `stakerShareBps` and `minStakerPrincipal` are read from configuration and never written again.

**Sweeps cannot be redirected.** `fee_sweep` and `dust_sweep` accept only `{amount, txRef}`. The destination is read from contract configuration internally, so the caller cannot choose where funds go.

**Accruals are bounded.** A fee sweep can never exceed `feesAccrued − feesSwept`; a dust sweep can never exceed the accumulated dust counter. The two counters are separate, so one cannot reach into the other.

**Fee tiers are frozen.** The rates live as constants in `split.mjs`, which the version lock pins byte-for-byte. There is no path by which a caller supplies or overrides a rate.

---

## Fixes applied during this review

Earlier passes surfaced six gaps that were closed before launch:

1. **Rounding dust was unreachable.** Integer remainders accumulated in a counter no operation could move. Added a bounded operator sweep for dust only — fees remain untouchable from it.
2. **Exit had no floor.** A member could create unlimited one-unit exit records and bloat replicated state. Exit now enforces the same 0.001 minimum as a deposit.
3. **Init accepted degenerate configuration.** The pool wallet and fee receiver are now required to differ; a fee receiver equal to the pool wallet would mix member principal with operator fees.
4. **No solvency check.** Added a read-only operation comparing principal owed, earnings owed, unswept fees and dust against the on-chain balance. It never moves funds.
5. **Redeposit during a pending exit was allowed.** The ledger could count new money while old money was still queued out. Deposits are now refused while an exit is pending, and accepted again once it settles.
6. **Deep simulation re-audit (v6):** a 1000-case randomized sweep with mixed staker flags surfaced a dividend semantics question — whether a staker's `net + dividend` may exceed their pro-rata gross. Resolution: staker dividends are a **redistribution of collected fees**, so the binding invariants are (a) a non-staker never loses more than their own fee, (b) the dividend pool never exceeds `stakerShareBps` of `feeTotal`, (c) exact conservation. An initial stricter cap (`net + dividend <= gross`) was evaluated and rejected — it zeroes out staker dividends entirely, since stakers pay 0% fee and have zero headroom. The fee-redistribution semantics is the economically correct one and is now documented in `split.mjs` and enforced by the test suite.
7. **Auto-stake feature + stub fidelity fix (v6.1):** added a member-owned `autoStake` preference (`set_auto_stake`, peer-bound, toggleable any time, effective next settle) — compounding members earn into `principal`, others into `earnings`, with compounding refused while an exit is pending. The first audit run failed its own compound check and exposed that the **test stub returned live object references** instead of fresh copies, letting in-place mutation leak past the storage boundary — unfaithful to trac-peer, where `get` deserializes. The stub now deep-copies on `get`/`put`; the contract logic itself required no change. Audit grew to 80 checks.

---

## Residual risks

These are stated plainly because they are properties of the design, not bugs waiting to be fixed.

### 1. Operator trust (custodial)

The operator alone credits deposits and states settlement amounts. A dishonest operator could misreport a round's payout.

The mitigation is transparency, not code. The pool wallet address is public, the gateway reports its balance, and every member peer holds a replicated copy of the ledger. Any mismatch is visible to all members simultaneously.

**This cannot be removed while the operator holds the keys.** RESET has no multisig or pooling primitive. A dishonest operator is detectable and attributable — not prevented.

### 2. Registration binding

Anyone can register any RESET address to their own peer key. The impact is griefing, not theft: payouts go on-chain to the RESET address itself, so a squatter cannot receive another member's coins. But the legitimate owner could be blocked from requesting payouts under that binding.

Mitigation is procedural and already part of the operator workflow: credit a deposit only after verifying a `sign_challenge` ownership proof for the registering peer.

### 3. Framework trust

`trac-peer` and `trac-msb` were out of scope. The pool inherits their correctness. All peers must run the identical contract version — a single byte of divergence splits the ledger.

### 4. Key custody

The pool wallet's keystore and password live on the operator's host with restricted permissions and a backup. Whoever holds them holds the pool's funds. That is the operator, by design.

---

## Release hashes

```
fe06ee601c2eb7a5e1e015ee35ad9c04  contract/contract.js
fd12e721351cddad91d77aee3728d1e1  contract/protocol.js
a2215a1bc5fc1b3f88a598aafb3271cc  contract/split.mjs
```

Re-run both suites after any contract change:

```sh
node --test tests/pool-split.test.mjs && node tests/audit.mjs
```
