// Funding indexer — the "funded by the same wallet" layer of the bubble map.
//
// A contract's transfer graph shows who holds and who sent to whom, but the strongest insider/
// sybil signal is WHICH WALLETS SHARE A GAS FUNDER. That needs native-ETH transfer history,
// which the free RPC can't bulk-query — so this layer uses Alchemy (getAssetTransfers,
// category=external) and is the ONLY part that spends CU. Run it sparingly (cron / on demand).
//
// For each of a token's top holders it finds the EARLIEST external (native) transfer into that
// wallet — its first funder — and stores (wallet, funder, block) in bm_funding. Holders that
// resolve to the same funder are then clustered by lib/graph.attachFundingClusters at serve time.
//
//   node scripts/index-funding.mjs [tokenAddress]
//   FUND_MAX_WALLETS=150  cap holders resolved per run (CU control)
import { getAssetTransfers, usingAlchemy } from "../lib/rpc.mjs";
import { getTransfers, getFunding, upsertFunding, hasDb } from "../lib/db.mjs";
import { buildGraphFromRows } from "../lib/graph.mjs";

const STAG = "0xcC142366735c882F7885d3c747db99e45E13E453";
const ZERO = "0x0000000000000000000000000000000000000000";

// A wallet's FIRST funder is immutable, so we crawl each wallet exactly once — ever. `budget`
// caps NEW wallets resolved per run (function-timeout control, NOT a coverage cap): unknown
// holders are spread across runs and the crawl is resumable. Default is "all holders", because
// with store-once the lifetime cost is just (unique wallets) x 1 call, chain-wide.
export async function indexFunding(token = STAG, {
  max = parseInt(process.env.FUND_MAX_WALLETS || "0", 10),          // 0 = all holders
  budget = parseInt(process.env.FUND_BUDGET || "400", 10),          // new wallets/run
} = {}) {
  if (!hasDb()) throw new Error("BUBBLE_DATABASE_URL not set");
  if (!usingAlchemy()) throw new Error("funding layer needs ALCHEMY_RPC_URL (free RPC can't pull native transfers)");
  const t = token.toLowerCase();

  // holder set from the stored transfer graph, biggest first (resolve the whales first)
  const rows = await getTransfers(t);
  if (!rows.length) throw new Error(`token ${t} not indexed yet — run the transfer backfill first`);
  const g = buildGraphFromRows(rows, { token: t });
  let holders = g.nodes.filter((n) => !n.tag).sort((a, b) => (b.pct - a.pct)).map((n) => n.id);
  if (max > 0) holders = holders.slice(0, max);

  // store-once: drop wallets already resolved in any prior run (they can't change)
  const known = new Set((await getFunding(holders)).map((r) => String(r.wallet).toLowerCase()));
  const todo = holders.filter((w) => !known.has(w));
  const batch = budget > 0 ? todo.slice(0, budget) : todo;

  const found = [];
  for (const w of batch) {
    try {
      const r = await getAssetTransfers({
        toAddress: w, category: ["external"], order: "asc", maxCount: "0x1", withMetadata: false, excludeZeroValue: true,
      });
      const tr = r && r.transfers && r.transfers[0];
      if (tr && tr.from && tr.from.toLowerCase() !== ZERO) {
        found.push({ wallet: w, funder: tr.from.toLowerCase(), block: parseInt(tr.blockNum, 16) });
      }
    } catch (e) { /* skip this wallet, keep going */ }
  }
  const written = await upsertFunding(found);
  return { token: t, holders: holders.length, alreadyKnown: known.size, scanned: batch.length, remaining: Math.max(0, todo.length - batch.length), newEdges: found.length, written };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  indexFunding(process.argv[2]).then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((e) => { console.error("funding indexer error:", e.message || e); process.exit(1); });
}
