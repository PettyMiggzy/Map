// Vercel Cron: GET /api/verify-pacts-cron — the automated Sherwood Pact oracle.
// Scans open-but-ended pacts, checks continuous holding against the indexed history, and
// submits verify() as the oracle key. Schedule in vercel.json. Requires ORACLE_KEY +
// PACT_ADDRESS + BUBBLE_DATABASE_URL in the environment.
import { runVerifier } from "../scripts/verify-pacts.mjs";

export default async function handler(req, res) {
  // Fail CLOSED: this endpoint spends the oracle's gas, so it must be authenticated. If no
  // CRON_SECRET is configured we refuse rather than run open to the public.
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: "CRON_SECRET not set — refusing to run an unauthenticated oracle" });
  if ((req.headers.authorization || "") !== `Bearer ${secret}`) return res.status(401).json({ error: "unauthorized" });
  if (!process.env.PACT_ADDRESS) return res.status(500).json({ error: "PACT_ADDRESS not set" });
  if (!process.env.ORACLE_KEY) return res.status(500).json({ error: "ORACLE_KEY not set" });
  try {
    const r = await runVerifier();
    return res.json({ ok: true, ...r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
