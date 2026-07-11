// Vercel serverless endpoint: GET /api/bubblemap?token=0x...
// Serves the precomputed graph from Postgres. The frontend reads from THIS endpoint,
// never from Alchemy — so viewer traffic costs $0 CU regardless of scale.
//
//   default            -> rebuild graph from stored bm_transfers rows (DB)
//   ?live=1            -> recompute straight off the FREE RPC (Alchemy only on failure)
//   (no DB configured) -> serve the committed sample JSON if it matches the seeded token
import { readFileSync } from "node:fs";
import { fetchTransfers, buildGraph, buildGraphFromRows } from "../lib/graph.mjs";
import { hasDb, getTransfers, getTokenMeta } from "../lib/db.mjs";

const STAG = "0xcddb2d9838b7edab2f04af4943a6efe42c2f9f49";

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
