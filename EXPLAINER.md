# How the Pool Works

A plain-language walkthrough of what happens to your coins, from the moment you join to the moment you withdraw.

---

## 1. The problem this solves

RESET mining has a hard floor: a wallet must hold at least **0.1 RESET** in the Mine before a claim is accepted. Below that, the protocol does not reject your claim with a small payout — it rejects it entirely. You earn nothing.

That floor is not an oversight. It exists so that thousands of near-empty wallets cannot fill the claim lanes with dust and crowd out real participants.

The consequence is that someone holding 0.02 RESET cannot mine at all. The pool fixes that by combining many small deposits into one wallet large enough to clear the floor.

---

## 2. Who is involved

| Role | What they do |
|---|---|
| **Operator** | Runs the pool wallet, the claim loop, and the ledger. Earns the fee. |
| **Member** | Deposits RESET to be mined. Earns a pro-rata share of each round. |
| **Staker** | A member the operator has whitelisted. Pays no fee on their own earnings and receives a share of the fees collected from others. |

---

## 3. Your money, step by step

**a. Register.** You announce your RESET address to the pool through your Intercom peer. Your agent does this; there is a prompt for it.

**b. Prove ownership.** You sign a challenge with your wallet key. Without this proof, no deposit will ever be credited to your name — it is what stops someone else from registering your address and redirecting your payouts.

**c. Transfer.** You send RESET to the pool wallet. The address is public and fixed.

**d. Credit.** The operator matches the incoming transfer against your announcement and your registration. An exact match is credited automatically. Anything ambiguous goes to a manual review queue and is never guessed at.

**e. Ledger entry.** Your deposit becomes **principal** in the ledger. The ledger is not a private spreadsheet: it is a contract replicated to every member peer, including yours. You hold a copy and can read your own numbers at any time.

**f. Lock and claim.** The operator combines everyone's principal into one deposit and locks it in the Mine. The claim loop then claims **every round** — six Bitcoin blocks, about an hour — at level 1000, which is exactly the fair share. It never overclaims, because overclaiming earns strikes and penalties.

---

## 4. How the payout is split

A round's payout is strictly pro-rata. The pool's share of the network's emission is:

```
pool_share = pool_principal ÷ total_principal_of_all_claimers × round_emission
```

Your share of that is:

```
your_gross = pool_share × your_principal ÷ pool_principal
your_net   = your_gross − tier_fee
```

**Example.** The pool holds 10 RESET and you contributed 0.5 — a 5% stake. The round pays the pool 0.04 RESET. Your gross share is 0.002. At a 0.5 RESET principal you sit in the lowest tier, so the fee is 10% — 0.0002 — and you receive **0.0018**, credited to your earnings balance.

Note what did *not* happen: the percentage you earn is identical whether you contributed 0.001 or 50 RESET. Pooling buys access, never extra yield.

---

## 5. The fee

**Tiered by your own principal, on earnings only.**

| Your principal | Fee on your earnings |
|---|---|
| below 1 RESET | 10% |
| 1 – 5 RESET | 5% |
| 5 – 20 RESET | 2% |
| 20 RESET and above | 0% |

The rate depends on what *you* deposited, not on the pool total. Fair share is strictly pro-rata, so a fee always costs a large depositor more than mining solo would — the tiers keep that cost from making size pointless. At 20 RESET and above, the pool charges nothing and competes purely on convenience: never missing a round, never managing a server.

The fee is never taken from principal. When you exit, your principal comes back whole.

Fees accumulate in the ledger and are periodically swept by the operator. The amount accrued and the amount swept are both tracked in contract state, so the arithmetic is checkable at any time.

---

## 6. Withdrawing

**Earnings.** Withdrawable once your balance reaches **0.01 RESET**. Below that, earnings keep accumulating. The floor exists because a RESET transfer costs TNK in network fees — paying out 0.0004 would cost more than it delivers.

**Principal.** Exit follows the RESET protocol's own schedule, because the pool's funds sit in the Mine's locked deposit:

1. You request an exit.
2. The pool operator batches exits and unlocks the corresponding amount.
3. The protocol requires **144 counted blocks** — roughly 24 hours — before funds are released.
4. The operator withdraws and transfers your principal back.

Your principal is never reduced by fees. It comes back at the same size it went in.

---

## 7. Stakers

A staker is a capital provider the operator has chosen to whitelist. You cannot apply; the operation is operator-only.

A whitelisted member is *active* in a round when their principal is at least **0.5 RESET**. Active stakers get two things:

1. **0% fee** on their own mining earnings.
2. **50% of that round's collected fees**, split across all active stakers in proportion to their principal.

So a staker earns from two directions: their own mining, and a slice of everyone else's fees.

Below 0.5 RESET, a whitelisted member is treated as a normal member for that round — standard fee, no dividend. Whitelisting and revocation both apply from the next round's snapshot, never mid-round.

---

## 8. Network costs (TNK)

Every ledger transaction — registration, payout request, exit request — costs a fixed **0.03 TNK**, paid from your own peer wallet. TNK is the Trac Network's fee token; it is not RESET and it never goes to the pool.

Budget roughly **0.15 TNK** to cover all the initial steps. Keep some on hand if you plan to withdraw regularly.

---

## 9. Security and risk, stated plainly

**What is verified.**

The contract is tested adversarially: a full legitimate cycle plus replay attacks, privilege escalation, member overreach and operator overreach — 64 checks, each of which must be refused with the ledger state left byte-identical. The settlement arithmetic is separately proven conservative across 17 unit tests including a 500-case randomized sweep: every unit of a round's payout is accounted for as member net, fee, or dust, with nothing created and nothing lost.

**What is public.**

The pool wallet address is public. Anyone can read its balance from the gateway and reconcile it against the ledger. Every member peer holds a full copy of the ledger, so a discrepancy is visible to all members at once.

**The real risk.**

This pool is **custodial**. The pool wallet's keys are held by the operator, who signs the actual RESET transfers. The ledger makes cheating *detectable and attributable* — it cannot make it *impossible*. Depositing here means trusting the operator.

Start with an amount you would not mind losing. That is not a disclaimer; it is the accurate description of the trust model.

**One more thing.** Deposits sent before the pool is active are not lost — they sit in the pool wallet and can be returned — but they earn nothing until total principal clears 0.1 and the claim loop is running.

---

## 10. Joining

Every technical step is executed by your agent from a single official prompt the operator provides: create a wallet, run a peer with the pool contract, register, prove ownership, deposit. Done.

After that you monitor your principal and earnings from your own peer. You do not need to trust a website to know your balance — you hold the ledger.
