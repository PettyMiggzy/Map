// Token metadata from Blockscout (FREE, no Alchemy CU). Used by the backfill + cron.
const BS = process.env.BLOCKSCOUT_URL || "https://robinhoodchain.blockscout.com";

export async function tokenMeta(token) {
  try {
    const r = await fetch(`${BS}/api/v2/tokens/${token}`, { headers: { "user-agent": "rh-bubblemaps" } });
    if (!r.ok) return {};
    const j = await r.json();
    return {
      name: j.name ?? null,
      symbol: j.symbol ?? null,
      decimals: j.decimals != null ? parseInt(j.decimals, 10) : null,
    };
  } catch {
    return {};
  }
}
