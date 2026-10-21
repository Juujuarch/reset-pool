# RESET Mining Pool

An on-chain accounting contract that lets wallets holding **less than the 0.1 RESET minimum** participate in the RESET Mine.

The RESET protocol requires a locked deposit of at least `0.1` per wallet before any claim is accepted. That floor is deliberate — it keeps dust from flooding the claim lanes — but it also excludes anyone holding less. This pool aggregates many small deposits behind a single operator wallet, so a 0.001 RESET holder can mine alongside a 50 RESET holder.

The contract is the ledger. It lives on the Intercom subnet, is replicated to every member peer, and records contributions, per-round snapshots, settlements, and withdrawals. The operator runs the claim loop; the contract makes the numbers verifiable by anyone.

---

## Contents

- [How it works](#how-it-works)
- [Economics](#economics)
- [Stakers](#stakers)
- [What the contract enforces](#what-the-contract-enforces)
- [What it cannot enforce](#what-it-cannot-enforce)
- [Version lock](#version-lock)
- [Verify your copy](#verify-your-copy)
- [Running the tests](#running-the-tests)
- [Repository layout](#repository-layout)

---

## How it works

```
member                    operator                   RESET network
  │                          │                             │
  ├─ register address ──────►│                             │
  ├─ prove ownership ───────►│  (sign_challenge)           │
  ├─ transfer RESET ────────┼────────────────────────────►│ pool wallet
  │                          │                             │
  │                          ├─ verify transfer on-chain   │
  │                          ├─ credit principal in ledger │
  │                          ├─ lock combined deposit ────►│ Mine
  │                          │                             │
  │                          ├─ claim round (level 1000) ─►│
  │                          │◄──── payout settles ────────┤
  │                          ├─ snapshot principal         │
  │                          ├─ settle round in ledger     │
  │◄──── earnings balance ───┤                             │
  │                          │                             │
  ├─ request payout ────────►│                             │
  │◄──── RESET transfer ─────┤────────────────────────────►│
```

**Deposits.** A member sends RESET to the pool wallet and reports the transfer reference. The operator verifies it on-chain, then credits the member's principal in the ledger. A transfer is credited at most once — the reference is the idempotency key.

**Rounds.** A Mine round spans six Bitcoin blocks, roughly one hour. Claims must land in the first three. The pool claims every round at level 1000 — exactly its fair share, never more — so it never accrues strikes or penalties.

**Settlement.** When a round settles, the contract splits the payout pro-rata across the principal snapshot taken at claim time, deducts the member fee, and credits the remainder to each member's earnings balance. Integer arithmetic only; the rounding remainder is tracked separately and never silently absorbed.

**Withdrawals.** Earnings may be withdrawn once the balance reaches the payout floor. Principal exits follow the protocol's own unlock schedule: `unlock`, then 144 counted blocks (about 24 hours), then `withdraw`.

---

## Economics

| Parameter | Value |
|---|---|
| Minimum member deposit | `0.001 RESET` |
| Member fee | **Tiered 10% / 5% / 2% / 0%, on earnings only** |
| Earnings payout floor | `0.01 RESET` |
| Claim level | `1000` (fair share, never over) |
| Principal exit wait | 144 counted blocks (~24 h) |

**The fee is tiered by your own principal.** The rate depends on how much *you* have deposited, not on the pool total:

| Your principal | Fee on your earnings |
|---|---|
| below 1 RESET | **10%** |
| 1 – 5 RESET | **5%** |
| 5 – 20 RESET | **2%** |
| 20 RESET and above | **0%** |

Fair share is strictly pro-rata, so any fee makes a large depositor worse off than mining solo. The tiers exist so that size is not punished: the top rate stays modest for small participants, and it falls to zero for those large enough to be better off alone.

**The fee is never taken from principal.** Principal is returned in full on exit. Fees come only from the yield a round produces.

**Payouts have a floor.** Below 0.01 RESET, earnings keep accumulating in the ledger. A transfer costs more in TNK than a micro-payout is worth, so paying early would destroy value.

**Yield does not increase by pooling.** The Mine's fair share is linear in deposit:

```
fair = guideline × your_deposit ÷ total_deposit_of_all_claimers
```

Thirty people pooling 0.1 earn exactly what one person with 0.1 would earn. Pooling buys **access**, not extra yield. Any claim to the contrary is false.

---

## Stakers

A staker is a capital provider the operator has explicitly whitelisted. Nobody can self-appoint; the `set_staker` operation is operator-only.

A whitelisted member becomes an **active** staker in a round when their snapshot principal is at least **0.5 RESET**. Active stakers:

- pay **0% fee** on their own mining earnings, and
- receive **50% of the fees collected that round**, split pro-rata by their snapshot principal.

The remaining 50% of fees goes to the operator.

Below 0.5 RESET, a whitelisted member is treated as an ordinary member for that round — normal fee, no dividend. Whitelisting and revocation both take effect from the next round snapshot, never mid-round.

---

## What the contract enforces

The contract is deliberately narrow. Every parameter is written once at `pool_init` and there is **no operation anywhere that changes it afterwards** — not for the operator, not for anyone.

- **Principal and earnings can only move to their owner.** `payout_request` and `exit_request` are bound to the peer that registered the address.
- **Deposits are idempotent.** The same transfer reference can never be credited twice.
- **Rounds cannot be double-counted.** A round can be snapshotted once and settled once.
- **Settlement cannot exceed the real payout.** The operator supplies the settled amount; the contract splits it exactly, with conservation enforced by construction (`Σ nets + fee + dust = payout`).
- **Sweeps are bounded.** The operator can move accrued fees and the rounding remainder, and nothing else. Both are capped at what has actually accumulated, and both are recorded with a reference that cannot be reused.
- **No dust is created or destroyed.** Integer remainders accumulate in a dedicated counter rather than disappearing.

---

## What it cannot enforce

**Custody.** RESET has no multisig or pooling primitive. The pool wallet's keys belong to the operator, who signs the real transfers. The ledger makes accounting auditable — the pool address is public, the gateway reports its balance, and every member peer holds a copy of the ledger — but it cannot compel honest behaviour.

A dishonest operator is **detectable and attributable**, not prevented. That is the honest boundary of this design. Join with small amounts and reconcile the ledger against the chain yourself.

**Framework correctness.** The pool inherits whatever trac-peer and trac-msb do. A bug there is a bug here.

**Key custody.** Whoever holds the keystore and its password holds the funds.

---

## Version lock

**Every peer must run identical contract code.**

Intercom contract state is replicated deterministically. If your `contract.js`, `protocol.js`, or `split.mjs` differs from the operator's by a single byte, your copy of the ledger diverges and your balances stop matching everyone else's.

- Never edit the contract files locally.
- Take them only from this repository, at the version the operator announces.
- On an announced upgrade, every member upgrades at the same point. Not early, not late.

---

## Verify your copy

```sh
md5sum contract/contract.js contract/protocol.js contract/split.mjs
```

Expected for this release:

```
4d3c316d090852bd63b856d56204013b  contract/contract.js
fd12e721351cddad91d77aee3728d1e1  contract/protocol.js
218cc2c614b13cbd11d5e973258c75bc  contract/split.mjs
```

If any hash differs, stop. Re-copy from this repository before joining or continuing on the subnet.

---

## Running the tests

### Settlement math

No dependencies — `split.mjs` is a pure module.

```sh
node --test tests/pool-split.test.mjs
```

17 cases: tier thresholds, staker dividends pro-rata, rounding dust, and a 500-case randomized property sweep asserting exact conservation.

### Adversarial harness

Runs the real contract sources against a stubbed peer base, so the code under test is the code that would run on the subnet.

```sh
npm install
node tests/audit.mjs
```

64 checks. A complete legitimate cycle — init, three members, three deposits, snapshot, settle, sweep, staker round — interleaved with attacks: replay, privilege escalation, member overreach, operator overreach, and immutability assertions. Every refused operation must leave the state hash byte-identical.

---

## Repository layout

| Path | Purpose |
|---|---|
| `contract/contract.js` | The pool contract: members, principal, rounds, settlement, payouts |
| `contract/protocol.js` | Transaction routing — only the pool's own operations are accepted |
| `contract/split.mjs` | Settlement arithmetic, dependency-free and unit-tested standalone |
| `tests/pool-split.test.mjs` | Unit tests for the split math |
| `tests/audit.mjs` | Adversarial harness against the real contract sources |
| `EXPLAINER.md` | End-to-end walkthrough in plain language |
| `TUTORIAL.md` | Member guide: joining, fees, withdrawals |
| `SECURITY-AUDIT.md` | Pre-launch audit: what was attacked, what held, what remains |

---

## License

MIT — see [LICENSE](LICENSE).
