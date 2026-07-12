// Vercel Cron: GET /api/fund-cron — refresh the native-ETH funding layer for the seeded token(s).
// This is the ONLY job that spends Alchemy CU, so it runs infrequently (see vercel.json) and is
// a no-op unless ALCHEMY_RPC_URL is configured. Schedule + FUND_MAX_WALLETS control the CU spend.
import { indexFunding } from "../scripts/index-funding.mjs";
import { usingAlchemy } from "../lib/rpc.mjs";
import { hasDb } from "../lib/db.mjs";

const STAG = "0xcddb2d9838b7edab2f04af4943a6efe42c2f9f49";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers.authorization || "") !== `Bearer ${secret}`) return res.status(401).json({ error: "unauthorized" });
  if (!hasDb()) return res.status(500).json({ error: "BUBBLE_DATABASE_URL not set" });
  if (!usingAlchemy()) return res.json({ ok: true, skipped: "ALCHEMY_RPC_URL not set — funding layer disabled" });
  const tokens = (process.env.FUND_TOKENS || STAG).split(",").map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    try { out.push(await indexFunding(t)); } catch (e) { out.push({ token: t, error: String(e.message || e) }); }
  }
  return res.json({ ok: true, results: out });
}
