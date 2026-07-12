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
import { getTransfers, upsertFunding, hasDb } from "../lib/db.mjs";
import { buildGraphFromRows } from "../lib/graph.mjs";

const STAG = "0xcddb2d9838b7edab2f04af4943a6efe42c2f9f49";
const ZERO = "0x0000000000000000000000000000000000000000";

export async function indexFunding(token = STAG, { max = parseInt(process.env.FUND_MAX_WALLETS || "150", 10) } = {}) {
  if (!hasDb()) throw new Error("BUBBLE_DATABASE_URL not set");
  if (!usingAlchemy()) throw new Error("funding layer needs ALCHEMY_RPC_URL (free RPC can't pull native transfers)");
  const t = token.toLowerCase();

  // holder set from the stored transfer graph, biggest first (spend CU where it matters)
  const rows = await getTransfers(t);
  if (!rows.length) throw new Error(`token ${t} not indexed yet — run the transfer backfill first`);
  const g = buildGraphFromRows(rows, { token: t });
  const holders = g.nodes.filter((n) => !n.tag).sort((a, b) => (b.pct - a.pct)).slice(0, max).map((n) => n.id);

  const found = [];
  for (const w of holders) {
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
  return { token: t, holdersScanned: holders.length, fundingEdges: found.length, written };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  indexFunding(process.argv[2]).then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((e) => { console.error("funding indexer error:", e.message || e); process.exit(1); });
}
