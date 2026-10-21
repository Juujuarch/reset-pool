# Claim Loop — Operator Specification

The claim loop is the operator's automation: it claims Mine rounds, snapshots the
ledger, settles payouts, manages the Mine deposit against a data-derived liquidity
target, and processes payouts and exits. Every decision it makes is derived from
ledger state — never from fixed percentages or guesses.

**Golden rule: stick by data.** Every lock, unlock, payout, and sweep is justified
by a number read from the contract and the gateway in the same tick.

---

## Inputs (read every cycle)

| Source | Data | Used for |
|---|---|---|
| Gateway `/state` | `mine.r`, `window_open`, blocks to claim end, guideline | claim timing |
| Gateway `/account/VAULT` | balance on-chain | solvency + lockable math |
| Contract `pool_read` | totals (principal, earningsOwed, feesAccrued, feesSwept, dust) | solvency + liquid target |
| Contract members | per-member: principal, earnings, exiting, autoStake, staker | liquid target + settle |
| Ledger exit queue | pending exits with request timestamps | unlock scheduling |
| Ledger payout queue | requested payouts | payment batching |

## Liquidity target (computed, not configured)

```
LIQUID_MIN = Σ earnings_owed(non_autoStake members)      // payable on demand
           + Σ exiting                                    // exit queue, must be honored
           + Σ principal × exit_rate_estimate             // projected exits, see below
```

- Components 1–2 are exact ledger numbers.
- Component 3 starts at a conservative `expected_exit_rate = 0.10` and is **recomputed
  from observed data** once history exists (e.g. 30-day rolling average of exit
  volume ÷ principal). If a member turns autoStake off, the loop treats their whole
  principal as exit-intent and raises the estimate for the next cycle.
- `lockable = VAULT_balance − LIQUID_MIN`. The loop only ever locks `lockable`,
  and skips locking entirely if `lockable ≤ 0`.

## Cycle (every Mine round, ~1 hour)

1. **Read state.** Pull all inputs above. If the gateway is unreachable, do nothing
   and retry next cycle — never act on stale data.
2. **Claim (if window open).** Submit claim at level 1000 for VAULT. Record tx.
3. **Snapshot.** When the previous round's reward is counted (6 confs), write
   `round_snapshot { round }` to the contract.
4. **Settle.** On the round's settlement amount, write `round_settle`. Auto-stake
   members compound automatically; others accrue earnings.
5. **Maintain liquidity.** Compute `LIQUID_MIN`. If balance − LIQUID_MIN > 0 and no
   exit/payout is pending, lock the surplus. If a pending exit's unlock window must
   start, unlock the exact exit amount (never more).
6. **Payouts.** Process `payout_request` entries: transfer from VAULT, mark
   `payout_paid` with the txRef. Batch transfers where possible to save TNK.
7. **Exits.** For each `exit_request` past maturation (144 counted blocks after the
   operator's unlock), withdraw from Mine and transfer to the member, mark
   `exit_paid`. Batch unlocks/withdraws across members.
8. **Fee sweep.** When `feesAccrued − feesSwept` exceeds a threshold (default
   0.05 RESET), sweep to the configured receivers (50/50).
9. **Write dashboard state.** Serialize totals, members, rounds, and health to
   `data/pool-state.json` for the dashboard.
10. **Log.** Append a structured line per action to `activity.log` — every action
    is attributable to a ledger number.

## Solvency guard

Before any lock: run `solvency_read` with the current on-chain balance. If
`balance < principal_owed + earnings_owed + unswept_fees + dust`, the loop
**refuses to lock anything** and flags the pool unhealthy on the dashboard.
Locking while insolvent would hide a shortfall from members.

## Exit handling timeline

```
T+0       member exit_request (ledger; member pays 0.03 TNK)
T+0       loop unlocks exactly the exit amount from Mine (VAULT pays 0.03 TNK)
T+0..24h  protocol maturation (144 counted blocks, 0% yield)
T+24h     loop withdraws from Mine and transfers to the member (VAULT pays TNK)
          exit_paid recorded with txRef
```

Exits are batched: all pending unlocks go out in one transaction, all matured
withdrawals in one transaction, then per-member transfers. TNK cost per exit to
the operator approaches 2 × 0.03 ÷ batch_size.

## Failure behavior

| Condition | Action |
|---|---|
| Gateway unreachable | skip cycle, retry next round |
| Claim tx rejected | log raw error, do not retry blindly; inspect before resubmit |
| Balance below LIQUID_MIN | no lock; if exits pending, escalate to operator alert |
| Solvency check fails | freeze all locks, dashboard shows unhealthy, alert operator |
| Contract write fails | log + retry once with a fresh nonce; if it fails again, skip cycle |
| Dashboard state write fails | non-fatal, log and continue |

## What the loop never does

- Never locks more than `balance − LIQUID_MIN`.
- Never unlocks more than the pending exit queue.
- Never sweeps fees above `feesAccrued − feesSwept` (the contract enforces this
  too — the loop treats the contract's rejection as a stop sign, not an obstacle).
- Never settles a round it has not snapshotted.
- Never moves funds to any address except the ones in contract config
  (pool wallet, member payout, fee receivers).

Every one of these is also enforced by the contract itself. The loop's discipline
is redundant with the contract's enforcement — deliberately, so a loop bug cannot
override a ledger guarantee.

---

## Status

- [x] Spec written
- [ ] Implementation (`claim-loop.mjs`)
- [ ] Dry-run against mainnet with operator-owned funds
- [ ] systemd service (`reset-pool-loop.service`)
- [ ] Writes `data/pool-state.json` for the dashboard
