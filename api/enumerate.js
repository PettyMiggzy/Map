// Vercel endpoint / cron: GET /api/enumerate
// Whole-chain discovery — registers every ERC-20 on the chain into bm_tokens so the
// indexer cron will backfill + keep each one fresh. FREE (Blockscout only, $0 CU).
// Runs on a slower schedule than the indexer (see vercel.json) to pick up new launches.
import { discoverTokens } from "../lib/discover.mjs";
import { hasDb, registerToken } from "../lib/db.mjs";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: "unauthorized" });
  }
  if (!hasDb()) return res.status(500).json({ error: "BUBBLE_DATABASE_URL not set" });

  const minHolders = parseInt(req.query.minHolders ?? process.env.ENUM_MIN_HOLDERS ?? "2", 10);
  // Cap pages per invocation so we stay within the function timeout; discovery is resumable
  // because registerToken is idempotent — the next run re-walks and fills any gaps.
  const maxPages = parseInt(req.query.maxPages ?? process.env.ENUM_MAX_PAGES ?? "40", 10);

  let seen = 0, registered = 0, skipped = 0;
  try {
    for await (const t of discoverTokens({ maxPages })) {
      seen++;
      if (minHolders > 0 && (t.holdersCount ?? 0) < minHolders) { skipped++; continue; }
      await registerToken(t.token, { name: t.name, symbol: t.symbol, decimals: t.decimals });
      registered++;
    }
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e), registered, seen });
  }
  return res.json({ ok: true, registered, skipped, seen, minHolders, maxPages });
}
