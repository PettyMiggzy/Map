# RH Bubble Maps — Handoff / Continuity Doc

**Purpose:** bubble maps (à la bubblemaps.io) for the **entire Robinhood Chain** (chainId 4663).
Wallet holder graph per token: bubbles = wallets sized by % of supply, edges = transfers,
with clustering to expose insiders (same-block buys, common funding source).

This folder is **staged inside `catboy` only so it survives across sessions** (git remembers).
It is meant to become its **own repo + own Vercel project + own database** — see "Why standalone".

---

## STATUS (as of this session)

- ✅ Feasibility proven: pulled the **full $STAG graph off the FREE RPC** in ~3s. No node, no Alchemy CU.
- ✅ Working interactive viz built: `public/bubblemap.html` (self-contained, real $STAG data embedded).
  Published artifact: https://claude.ai/code/artifact/6c60b1e8-9a72-4c55-bc02-f81919db075c
- ✅ Core code scaffolded: `lib/rpc.mjs` (tiered), `lib/graph.mjs` (indexer/graph), `scripts/index-token.mjs`,
  `api/bubblemap.js`, `db/schema.sql`.
- ⬜ Not yet: standalone repo, Postgres wiring, incremental cron, whole-chain mode, native-funding clusters.

$STAG live graph snapshot: **85 holders, 353 transfer edges, 5 same-block clusters, top holder 33.4%**
(and the 33.4% wallet is NOT the LP pool — a real concentration finding).

---

## KEY DECISIONS (locked with the user "King")

1. **Free-first, Alchemy fallback.** Primary data = free public RPC `rpc.mainnet.chain.robinhood.com`
   + free Blockscout for metadata. Alchemy (`ALCHEMY_RPC_URL`) is used ONLY when the free RPC
   fails/rate-limits, or for `alchemy_getAssetTransfers` (native-funding clusters) which the free RPC can't do.
   Implemented in `lib/rpc.mjs`.
2. **Standalone repo + own Vercel project + own DB.** Do NOT share the catboy bot's Neon database —
   a heavy chain-wide indexer could exhaust connections/storage and take down the live $STAG payment bot.
   Reuse only the *accounts* (Vercel Pro, Alchemy) the user already pays for; ideally a **separate Alchemy app**
   for clean CU tracking (user has 29/30 app slots free).
3. **Serve every map from our own DB, never from Alchemy** → viewer traffic costs $0 CU regardless of scale.

## Cost (confirmed against user's real Alchemy dashboard)

- Alchemy rate $0.45 / 1M CU (→ $0.40 after 300M/mo). User currently ~350K CU/mo (basically idle),
  throughput cap 10K CU/s (peaks 2.4K — huge headroom).
- Whole-chain via `getAssetTransfers`: backfill ~8–10M CU (**~$4 once**), ongoing ~20–30M CU/mo
  (**~$10–14/mo** at current memecoin-frenzy volume). User **set a usage cap + alert** so no surprise bills.
- Chain scale now: 6.58M blocks, 35.1M txns, 1.01M addresses.

---

## ARCHITECTURE

```
FREE RH RPC (primary) ──┐
Blockscout (metadata) ──┼─►  lib/graph.mjs (eth_getLogs → balances, edges, same-block clusters)
Alchemy (FALLBACK only)─┘        │
                                 ├─► Postgres (bm_transfers, bm_cursor, bm_funding)  [db/schema.sql]
                                 │        (SEPARATE Neon DB from the bot!)
                                 ├─► api/bubblemap.js  (GET ?token=0x... → graph JSON, served from DB)
                                 └─► public/bubblemap.html  (vanilla canvas force-directed viz)
Phase 2: Alchemy getAssetTransfers category=external → bm_funding → "funded by same wallet" clusters
```

## FILES

- `lib/rpc.mjs` — tiered RPC (free-first, Alchemy fallback), + `getAssetTransfers` (Alchemy-only).
- `lib/graph.mjs` — `fetchTransfers()` (chunked getLogs, auto-shrinks range) + `buildGraph()`.
- `scripts/index-token.mjs` — CLI backfill → `data/<sym>-graph.json`. `node scripts/index-token.mjs 0x<token>`.
- `api/bubblemap.js` — Vercel endpoint; serves cached graph, `?live=1` recomputes off free RPC.
- `db/schema.sql` — Postgres tables (transfers, cursor, funding).
- `public/bubblemap.html` — interactive viz, real $STAG data embedded (swap for API fetch in prod).
- `data/stag-graph.json` — sample seed.

## NEXT STEPS (new session pickup)

1. Create standalone repo `rh-bubblemaps` + Vercel project + **new Neon DB** (separate from bot).
   Move this `bubblemap/` folder's contents to the repo root.
2. Wire `scripts/index-token.mjs` + `api/bubblemap.js` to Postgres (`BUBBLE_DATABASE_URL`) instead of JSON.
3. Add `api/index-cron.js` (incremental: read `bm_cursor`, fetch new blocks, upsert). vercel.json cron is set.
4. Point frontend at `/api/bubblemap?token=` instead of embedded JSON; add a token search box.
5. Whole-chain mode: enumerate tokens (Blockscout `/api/v2/tokens` paginated, free) → index each.
6. Phase 2: add `ALCHEMY_RPC_URL`, backfill native funding via `getAssetTransfers`, render funder clusters.

## RELATED THREAD (separate task, same session)

$STAG contract verification / Pump.fun "scam" flag: token is a **NOXA Fun** launch (factory
`0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB`). Source is unverified everywhere (checked RH mainnet+testnet
Blockscout, MegaETH, Monad, Sourcify, GitHub, IPFS — all empty; NOXA strips metadata `bytecodeHash:none`,
solc 0.8.30). Fix = NOXA verifies their template once (Blockscout auto-matches all their tokens) or sends
the `.sol`. Ask: `@Noxa_Fi` / AmunPhantom. On-chain genuineness IS provable via `launchFactory()` /
`getLaunchedToken()`. Not part of bubble maps — noted for continuity.

---

## INTEGRATING INTO THE $STAG SITE (separate repo + Vercel + domain)

The $STAG utility site is its **own** GitHub repo + Vercel project + domain (NOT catboy).
The bubble map is also standalone. Connect them WITHOUT merging code or DBs:

**Recommended — subdomain + nav button:**
1. Deploy bubble-map repo as its own Vercel project.
2. That project → Settings → Domains → add `bubbles.<stag-domain>`; DNS CNAME `bubbles` → `cname.vercel-dns.com`.
3. Add one nav button on the $STAG site linking to `https://bubbles.<stag-domain>`.

**Alternative — path rewrite** in the $STAG site's `vercel.json`:
```json
{ "rewrites": [
  { "source": "/bubbles", "destination": "https://<bubblemap-project>.vercel.app/bubblemap.html" },
  { "source": "/bubbles/:path*", "destination": "https://<bubblemap-project>.vercel.app/:path*" }
]}
```

**Ready-to-paste nav button** (restyle to match the $STAG nav):
```html
<a href="https://bubbles.<stag-domain>" class="nav-link" rel="noopener">Bubble Map</a>
```

**To wire this in a future session:** grant GitHub access to BOTH repos — the bubble-map repo AND the
$STAG site repo — so the nav-link/rewrite edit can be made. Otherwise it's a 30-sec manual edit on the site.
