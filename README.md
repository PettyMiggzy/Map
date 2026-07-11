# RH Bubble Maps

Bubble maps for **Robinhood Chain** (chainId 4663). Wallet holder graphs: bubbles sized by
% of supply, edges = transfers, clusters expose same-block buyers and common funders.

**Free-first:** everything runs on the public RPC + Blockscout ($0). Alchemy is optional
fallback for rate-limit relief and native-funding cluster data. Maps are **served from our
own Postgres**, never from Alchemy — so viewer traffic costs $0 CU at any scale.

## Quick start (no database — prototype)
```bash
cp .env.example .env
node scripts/index-token.mjs 0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49   # $STAG
# no BUBBLE_DATABASE_URL set -> writes data/<sym>-graph.json → open public/bubblemap.html
```

## With the database (production path)
1. Create a **separate** Neon project (never the catboy bot's DB). See `HANDOFF.md`.
2. Load the schema and set the env var:
   ```bash
   psql "$BUBBLE_DATABASE_URL" -f db/schema.sql
   export BUBBLE_DATABASE_URL=postgres://…            # pooled Neon connection string
   ```
3. Backfill a token (upserts `bm_transfers` + `bm_cursor` + `bm_tokens`):
   ```bash
   node scripts/index-token.mjs 0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49
   ```

## Whole-chain mode
This is a map of the **entire Robinhood Chain**, not one token. Discovery registers every
ERC-20 into `bm_tokens`; the indexer cron then backfills + refreshes each one.
```bash
node scripts/enumerate-tokens.mjs                 # register all ERC-20s (skips <2-holder dust)
node scripts/enumerate-tokens.mjs --min-holders 0 # literally every token
```
`/api/enumerate` does the same on an hourly cron to catch new launches. The indexer cron
backfills **never-indexed tokens first** (ordered by `bm_cursor` recency, nulls first), then
round-robins to keep everything fresh — so a fresh chain drains fairly without starving new tokens.

## API
- `GET /api/bubblemap?token=0x…` — graph JSON rebuilt from the DB (cached at the edge).
- `GET /api/bubblemap?token=0x…&live=1` — recompute straight off the free RPC (bypasses DB).
- `GET /api/tokens?q=&limit=&offset=` — registry list / search for the frontend token picker.
- `GET /api/index-cron` — incremental indexer; advances `active` tokens from their cursor
  (`CRON_MAX_TOKENS` per tick). Scheduled every 2 min. Guard with `CRON_SECRET` in prod.
- `GET /api/enumerate` — whole-chain discovery; registers ERC-20s into `bm_tokens`. Hourly cron.

## Env
| var | role |
|-----|------|
| `RH_RPC_URL` | free public RPC (default set) — **primary** |
| `BUBBLE_DATABASE_URL` | **separate** Neon Postgres — serve + index target |
| `ALCHEMY_RPC_URL` | fallback only (rate-limit relief, phase-2 native funding) |
| `CRON_SECRET` | optional bearer token to protect `/api/index-cron` + `/api/enumerate` |
| `CRON_MAX_TOKENS` | tokens advanced per indexer tick (default 8) |
| `ENUM_MIN_HOLDERS` | skip dust below N holders during discovery (default 2) |
| `ENUM_MAX_PAGES` | Blockscout pages per `/api/enumerate` invocation (default 40) |

## Deploy
Standalone Vercel project (Node functions in `api/`, static `public/`). Set a **separate**
`BUBBLE_DATABASE_URL` (Neon) — do not reuse another app's database. See `HANDOFF.md` for the full plan.
