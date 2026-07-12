# Sherwood Pact — Automated Oracle

The pact reward payout can't be trustless (a contract can't read past balances), so an off-chain
**oracle** decides "did this wallet hold its pledge?" and calls `verify()`. This is that oracle,
running on the **same bubble-map indexer + Neon DB** — no separate infra.

## What it does
1. `openPactsPastWindow(0, N)` → every OPEN pact whose hold window has ended.
2. For each: reconstruct the wallet's `$STAG` balance from the indexed transfer history and check it
   stayed **≥ the pledged amount for the whole window** (`lib/holding.mjs`).
3. Submit `verify(id, held, reward)` as the oracle key — held → refund + reward payable; not held →
   forfeited. Past-grace pacts are skipped (the holder's `reclaim` right takes over).

It's idempotent (resolved pacts leave the Open set) and **fail-safe**: if the index history doesn't
reach back before a pact's start, that pact is **skipped**, never wrongly forfeited.

## One-time setup
1. **Index $STAG from genesis** (required — the check reconstructs balance from the token's first
   transfer): `npm run index:stag`  (backfills `0xCDdB…9F49` into `bm_transfers`). The `/api/index-cron`
   then keeps it current every 2 min.
2. **Fund an oracle wallet** with a little RH-ETH for gas, and point the pact's oracle at it:
   in `/admin → Sherwood Pact → Oracle`, `setOracle(<that wallet>)`.
3. Set env (Vercel project / local):

| Env | Meaning |
|-----|---------|
| `BUBBLE_DATABASE_URL` | the indexer's Neon DB (holding history) |
| `RH_RPC_URL` | free RPC (default mainnet) |
| `PACT_ADDRESS` | `0xc36662D2db9432702f018963ABdab19432AA488B` |
| `STAG_ADDRESS` | pledged token (default $STAG) |
| `ORACLE_KEY` | private key of the oracle wallet |
| `REWARD_ETH` | reward paid on held=true (default `0` → just the refund) |
| `CRON_SECRET` | optional bearer guard for the cron endpoint |

## Running
- **Automatic:** `/api/verify-pacts-cron` runs every 10 min (see `vercel.json`).
- **Manual / CLI:** `node scripts/verify-pacts.mjs`
- **Dry run (no transactions, prints decisions + evidence):** `DRY_RUN=1 node scripts/verify-pacts.mjs`

## Correctness
The pure decision core (`decideFromSeries`) is cross-checked against an independent brute-force
reference over 50,000 randomized transfer histories + windows (`node scripts/simulate-holding.mjs`),
including windows snapped onto event boundaries — 0 mismatches.

Assumes `$STAG` is 18 decimals (asserted at runtime). The check is **minimum-balance over the
window** — a wallet must never dip below its pledge at any indexed transfer, not merely end above it.
