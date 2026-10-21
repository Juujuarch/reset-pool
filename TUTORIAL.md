# Member Guide

Everything you need to join the pool, read your numbers, and get your coins back.

---

## Before you start

| You need | Why |
|---|---|
| A RESET wallet | Your deposit comes from it, your payouts go back to it |
| **0.001 RESET** minimum | The smallest deposit the contract accepts |
| **~0.15 TNK** | Network fees for registration, payout and exit transactions |
| An Intercom peer | The pool ledger is replicated over the subnet |

You do not need 0.1 RESET. That is the point of the pool.

---

## Step 1 — Register your address

Registration binds your RESET address to your peer. It is free of pool fees; only the 0.03 TNK network fee applies.

The operator's prompt does this for you. If you are doing it manually, the operation is:

```json
{ "op": "member_register", "member": "<your 64-hex RESET address>" }
```

Once registered, the address is tied to your peer. Another peer cannot re-register it and claim your payouts.

---

## Step 2 — Prove ownership

Sign a challenge with your wallet key. The operator verifies it before crediting anything.

```sh
node bin/reset-signer.mjs sign_challenge proof.json --audience <pool-audience>
```

This proves you hold the private key for the address you registered. It cannot move funds and cannot be reused elsewhere — it is bound to your address, a nonce, and an audience.

**Nothing is credited without this proof.** That is deliberate: it is the only thing standing between a squatter and your payout queue.

---

## Step 3 — Deposit

Send RESET to the pool wallet. The address is published by the operator and never changes.

Minimum: **0.001 RESET**. Below that the contract refuses the credit.

Then report the transfer reference to the operator, who verifies it on-chain and credits your principal:

```json
{ "op": "deposit_credit", "member": "<your address>", "amount": "<units>", "txRef": "<transfer reference>" }
```

A transfer reference can be credited exactly once. If you send twice and report twice, both are credited — but the same reference twice is a no-op.

---

## Step 4 — Watch it work

Your principal is now part of the pool's locked deposit. Every round the pool claims, and when that round settles, your share lands in your earnings balance.

To read your own record from your peer:

```json
{ "op": "member_read", "member": "<your address>" }
```

You will see:

| Field | Meaning |
|---|---|
| `principal` | Your deposited amount, in base units |
| `earnings` | Accumulated, not-yet-withdrawn yield |
| `exiting` | Principal currently in the exit queue |
| `staker` | Whether the operator has whitelisted you |

---

## Fees at a glance

| Item | Amount |
|---|---|
| Pool fee on earnings | **10% / 5% / 2% / 0% by principal** |
| Pool fee on principal | **0%** — always |
| Network fee per transaction | 0.03 TNK |
| Minimum deposit | 0.001 RESET |
| Minimum payout | 0.01 RESET |

The rate applies to what your share earns, never to what you deposited:

| Your principal | Fee |
|---|---|
| below 1 RESET | 10% |
| 1 – 5 RESET | 5% |
| 5 – 20 RESET | 2% |
| 20 RESET and above | 0% |

The rate follows your own principal, not the pool's size.

---

## Withdrawing earnings

Request a payout once your balance reaches **0.01 RESET**:

```json
{ "op": "payout_request", "member": "<your address>", "amount": "<units>" }
```

The operator executes the transfer and marks it paid with a reference:

```json
{ "op": "payout_paid", "id": "po1", "txRef": "<transfer reference>" }
```

Below 0.01, earnings keep accumulating. This is not a restriction for its own sake — a RESET transfer costs TNK, and paying out fractions of a cent would cost more than it delivers.

If a payout is requested in error, the operator can return the amount to your balance with `payout_cancel`.

---

## Withdrawing principal

Principal exits follow the RESET protocol's own schedule, because pool funds sit inside the Mine's locked deposit.

1. **Request the exit.** Minimum 0.001 RESET.

```json
{ "op": "exit_request", "member": "<your address>", "amount": "<units>" }
```

2. **The operator batches exits and unlocks.** The protocol then requires **144 counted blocks** — about 24 hours — before funds are released.

3. **The operator withdraws and transfers.** Your principal arrives whole. Fees were never taken from it.

While an exit is pending, the contract refuses new deposits to your address. This keeps the snapshot honest: the ledger will not count new money while old money is still queued out. Once the exit is paid, depositing works again.

---

## Stakers

If the operator whitelists you and your principal is at least **0.5 RESET**, you are an *active staker* for that round:

- **0% fee** on your own earnings
- **50% of the round's collected fees**, split across active stakers by principal

Below 0.5 RESET you are treated as a normal member that round — your usual tier fee, no dividend.

You cannot whitelist yourself. The operation is operator-only, and changes apply from the next round's snapshot, never mid-round.

---

## Checking the pool is solvent

At any time you can ask the contract to compare what it owes against what the wallet actually holds:

```json
{ "op": "solvency_read", "onchain": "<pool balance read from the gateway>" }
```

It reports principal owed, earnings owed, unswept fees, dust, and whether the on-chain balance covers the total. It never moves funds — it only compares.

If that check ever fails, stop depositing and reconcile with the operator. The ledger is replicated to your peer, so you can verify the numbers independently rather than taking anyone's word for it.

---

## Quick reference

```text
register        member_register   { member }
prove           sign_challenge    (local, offline)
deposit         deposit_credit    { member, amount, txRef }
read self       member_read       { member }
request payout  payout_request    { member, amount }
request exit    exit_request      { member, amount }
check solvency  solvency_read     { onchain }
read pool       pool_read         (no arguments)
```

---

## If something looks wrong

1. Compare your peer's contract hashes against the published ones. A mismatch means you are running different code and your balances will diverge — stop and re-copy.
2. Run `solvency_read` with the current on-chain balance.
3. Check `pool_read` for the operator's configuration and current totals.
4. Bring the numbers to the operator. Because every member holds the ledger, a discrepancy is not one person's word against another's.
