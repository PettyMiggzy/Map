// Vercel serverless endpoint: GET /api/tokens?q=&limit=&offset=
// Lists tokens in the whole-chain registry for the frontend picker / search box.
// Served from our own DB → $0 Alchemy CU. Indexed tokens (by holder count) rank first.
import { hasDb, listTokens } from "../lib/db.mjs";

export default async function handler(req, res) {
  if (!hasDb()) return res.status(500).json({ error: "BUBBLE_DATABASE_URL not set" });
  const limit = Math.min(parseInt(req.query.limit ?? "100", 10) || 100, 500);
  const offset = Math.max(parseInt(req.query.offset ?? "0", 10) || 0, 0);
  const q = req.query.q ? String(req.query.q).slice(0, 64) : null;
  try {
    const tokens = await listTokens({ limit, offset, q });
    res.setHeader("cache-control", "s-maxage=60, stale-while-revalidate=300");
    return res.json({ count: tokens.length, tokens });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
