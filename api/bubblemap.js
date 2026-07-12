// Vercel serverless endpoint: GET /api/bubblemap?token=0x...
// Serves the precomputed graph from Postgres. The frontend reads from THIS endpoint,
// never from Alchemy — so viewer traffic costs $0 CU regardless of scale.
//
//   default            -> rebuild graph from stored bm_transfers rows (DB)
//   ?live=1            -> recompute straight off the FREE RPC (Alchemy only on failure)
//   (no DB configured) -> serve the committed sample JSON if it matches the seeded token
import { readFileSync } from "node:fs";
import { fetchTransfers, buildGraph, buildGraphFromRows, attachFundingClusters } from "../lib/graph.mjs";
import { hasDb, getTransfers, getTokenMeta, getFunding, getLabels, upsertLabels } from "../lib/db.mjs";
import { classifyAddresses } from "../lib/rpc.mjs";

const STAG = "0xcddb2d9838b7edab2f04af4943a6efe42c2f9f49";

// Tag holders that are contracts so liquidity pools / routers / staking contracts aren't shown
// as whales. Labels are cached store-once in bm_labels; only the top untagged holders are probed
// via eth_getCode (free RPC, $0 CU) on a cache miss. A contract that both sends AND receives the
// token is a pool ('LP Pool'); a receive-only contract is 'Contract'. Best-effort — never throws.
async function enrichLabels(g, { probeTop = 15 } = {}) {
  try {
    const nodes = g.nodes;
    const ids = nodes.map((n) => n.id);
    const known = await getLabels(ids);                       // address -> 'LP Pool'|'Contract'|'EOA'
    // bidirectional flow: an address that is both a sender and a receiver of the token
    const senders = new Set((g.edges || []).map((e) => e.from));
    const receivers = new Set((g.edges || []).map((e) => e.to));
    const applyTag = (n) => {
      const lbl = known.get(n.id);
      if (lbl === "LP Pool" || lbl === "Contract") { if (!n.tag) n.tag = lbl; }
    };
    nodes.forEach(applyTag);
    // probe the biggest still-unknown, non-burn holders
    const toProbe = nodes
      .filter((n) => n.tag !== "burn" && !known.has(n.id))
      .sort((a, b) => (b.pct || 0) - (a.pct || 0))
      .slice(0, probeTop)
      .map((n) => n.id);
    if (!toProbe.length) return g;
    const kinds = await classifyAddresses(toProbe);           // address -> 'contract'|'eoa'
    const writes = [];
    for (const [addr, kind] of kinds) {
      if (kind === "contract") {
        const isPool = senders.has(addr) && receivers.has(addr);
        const label = isPool ? "LP Pool" : "Contract";
        writes.push({ address: addr, label });
        const n = nodes.find((x) => x.id === addr);
        if (n && !n.tag) n.tag = label;
      } else {
        writes.push({ address: addr, label: "EOA" });         // cache so we never re-probe
      }
    }
    upsertLabels(writes).catch(() => {});                     // fire-and-forget cache write
  } catch { /* labeling is best-effort — never block the serve */ }
  return g;
}

export default async function handler(req, res) {
  const token = (req.query.token || STAG).toLowerCase();
  const live = req.query.live === "1"; // recompute from RPC instead of the DB cache
  try {
    if (live) {
      const { logs } = await fetchTransfers(token);
      const g = buildGraph(logs, { token });
      res.setHeader("cache-control", "s-maxage=120");
      return res.json(g);
    }

    if (hasDb()) {
      const rows = await getTransfers(token);
      if (!rows.length) {
        return res.status(404).json({ error: "token not indexed yet", token });
      }
      const meta = (await getTokenMeta(token)) || {};
      const g = buildGraphFromRows(rows, { token, meta });
      // overlay "funded by the same wallet" clusters if the funding layer has been indexed
      try { const funding = await getFunding(g.nodes.map((n) => n.id)); if (funding.length) attachFundingClusters(g, funding); } catch {}
      res.setHeader("cache-control", "s-maxage=300, stale-while-revalidate=600");
      return res.json(g);
    }

    // No DB configured -> serve the committed sample if it's the seeded token (prototype).
    try {
      const g = JSON.parse(readFileSync(`${process.cwd()}/data/stag-graph.json`, "utf8"));
      if (g.token.address === token) { res.setHeader("cache-control", "s-maxage=300"); return res.json(g); }
    } catch {}
    return res.status(404).json({ error: "no database configured and no sample for token", token });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
