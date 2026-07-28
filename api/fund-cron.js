// Vercel Cron: GET /api/fund-cron — refresh the native-ETH funding layer for the seeded token(s).
// This is the ONLY job that spends Alchemy CU, so it runs infrequently (see vercel.json) and is
// a no-op unless ALCHEMY_RPC_URL is configured. Schedule + FUND_MAX_WALLETS control the CU spend.
import { indexFunding } from "../scripts/index-funding.mjs";
import { usingAlchemy } from "../lib/rpc.mjs";
import { hasDb, listActiveTokens } from "../lib/db.mjs";

const STAG = "0xcC142366735c882F7885d3c747db99e45E13E453";

// Refresh the funding layer for EVERY indexed Robinhood Chain token (store-once keeps this
// cheap — each wallet is crawled once, ever). FUND_TOKENS pins a subset; otherwise we pull
// the active token list from the DB. FUND_MAX_TOKENS caps tokens/run so we stay inside the
// function timeout; the crawl is resumable (whales + unknown wallets first).
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers.authorization || "") !== `Bearer ${secret}`) return res.status(401).json({ error: "unauthorized" });
  if (!hasDb()) return res.status(500).json({ error: "BUBBLE_DATABASE_URL not set" });
  if (!usingAlchemy()) return res.json({ ok: true, skipped: "ALCHEMY_RPC_URL not set — funding layer disabled" });

  const pinned = (process.env.FUND_TOKENS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const maxTokens = parseInt(process.env.FUND_MAX_TOKENS || "25", 10);
  let tokens;
  if (pinned.length) tokens = pinned;
  else {
    const active = await listActiveTokens(500).catch(() => []);
    tokens = active.map((r) => String(r.token || r.address || r).toLowerCase());
    if (!tokens.includes(STAG)) tokens.unshift(STAG); // always keep $STAG covered
  }
  if (maxTokens > 0) tokens = tokens.slice(0, maxTokens);

  // One GLOBAL wallet budget for the whole run (not per-token) so we never exceed the
  // function timeout no matter how many tokens are due. Whichever token is processed first
  // spends from the shared pool; the rest carry to the next run (store-once = resumable).
  let remaining = parseInt(process.env.FUND_BUDGET || "400", 10);
  const out = [];
  for (const t of tokens) {
    if (remaining <= 0) { out.push({ token: t, skipped: "run budget spent" }); continue; }
    try { const r = await indexFunding(t, { budget: remaining }); remaining -= (r.scanned || 0); out.push(r); }
    catch (e) { out.push({ token: t, error: String(e.message || e) }); }
  }
  const newEdges = out.reduce((s, r) => s + (r.newEdges || 0), 0);
  return res.json({ ok: true, tokens: tokens.length, budgetSpent: parseInt(process.env.FUND_BUDGET || "400", 10) - remaining, newEdges, results: out });
}
