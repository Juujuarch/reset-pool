# Security Audit — v5

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

**No drain path found.** No operation lets an outsider or a member take funds that are not theirs.

### Attacks refused

| Category | Attempts |
|---|---|
| **Privilege** | Non-operator calling `pool_init`, `deposit_credit`, `round_snapshot`, `round_settle`, `set_staker`, `fee_sweep`, `dust_sweep`, `payout_paid`, `payout_cancel`, `exit_paid` |
| **Replay** | Second `pool_init`; double credit of one transfer reference; double snapshot; double settle; double sweep of one reference |
| **Member overreach** | Payout below the floor; payout above own earnings; payout against another member's record; exit above own principal; exit below the minimum; self-appointment as staker |
| **Operator overreach** | Settle a round never snapshotted; credit an unregistered member; credit below the minimum; staker flag on an unregistered address; sweep above accrued fees; dust sweep above accumulated dust |

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

Earlier passes surfaced five gaps that were closed before launch:

1. **Rounding dust was unreachable.** Integer remainders accumulated in a counter no operation could move. Added a bounded operator sweep for dust only — fees remain untouchable from it.
2. **Exit had no floor.** A member could create unlimited one-unit exit records and bloat replicated state. Exit now enforces the same 0.001 minimum as a deposit.
3. **Init accepted degenerate configuration.** The pool wallet and fee receiver are now required to differ; a fee receiver equal to the pool wallet would mix member principal with operator fees.
4. **No solvency check.** Added a read-only operation comparing principal owed, earnings owed, unswept fees and dust against the on-chain balance. It never moves funds.
5. **Redeposit during a pending exit was allowed.** The ledger could count new money while old money was still queued out. Deposits are now refused while an exit is pending, and accepted again once it settles.

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
d034471a78ab2bb20cc4d76a28b3f2c5  contract/contract.js
fd12e721351cddad91d77aee3728d1e1  contract/protocol.js
218cc2c614b13cbd11d5e973258c75bc  contract/split.mjs
```

Re-run both suites after any contract change:

```sh
node --test tests/pool-split.test.mjs && node tests/audit.mjs
```
