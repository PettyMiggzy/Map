// Vercel Cron: GET /api/index-cron  (schedule in vercel.json).
// Incrementally advances every active token in bm_tokens: read its cursor, pull only the
// NEW blocks off the FREE RPC, upsert, bump the cursor + summary. $0 Alchemy CU.
//
// Tokens are added to the registry by the backfill (scripts/index-token.mjs) or, later,
// by whole-chain enumeration. To limit per-invocation work (Vercel function timeout),
// only MAX_TOKENS_PER_RUN oldest-updated tokens are advanced each tick.
import { fetchTransfers, buildGraph, decodeTransferLogs } from "../lib/graph.mjs";
import { tokenMeta } from "../lib/meta.mjs";
import {
  hasDb, listActiveTokens, getCursor, upsertTransfers, setCursor, upsertToken,
} from "../lib/db.mjs";

const MAX_TOKENS_PER_RUN = parseInt(process.env.CRON_MAX_TOKENS || "8", 10);

export default async function handler(req, res) {
  // Optional shared-secret guard (set CRON_SECRET in Vercel to require it).
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: "unauthorized" });
  }
  if (!hasDb()) return res.status(500).json({ error: "BUBBLE_DATABASE_URL not set" });

  const tokens = await listActiveTokens(MAX_TOKENS_PER_RUN);
  const results = [];
  for (const { token } of tokens) {
    try {
      const from = (await getCursor(token)) + 1;
      const { logs, latest } = await fetchTransfers(token, from);
      if (logs.length) {
        await upsertTransfers(token, decodeTransferLogs(logs));
        const g = buildGraph(logs, { token });
        const m = await tokenMeta(token);
        await upsertToken(token, {
          ...m, holders: g.token.holders, supply: g.token.supply, transfers: g.transfers,
        });
      }
      await setCursor(token, latest);
      results.push({ token, from, latest, new: logs.length });
    } catch (e) {
      results.push({ token, error: String(e.message || e) });
    }
  }
  return res.json({ ok: true, indexed: results.length, results });
}
