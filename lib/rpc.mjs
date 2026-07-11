// Tiered RPC client for Robinhood Chain (chainId 4663).
// STRATEGY (per product decision): use FREE sources first, fall back to Alchemy only
// when the free RPC rate-limits/fails, or when a capability the free RPC lacks is needed
// (getAssetTransfers bulk, native-funding transfers, trace_). This keeps Alchemy CU ~0.
//
// Env:
//   RH_RPC_URL      free public RPC (default below) — PRIMARY
//   ALCHEMY_RPC_URL your Alchemy RH-Chain https endpoint — FALLBACK ONLY (optional)
//   RH_RPC_URL_2..  optional extra free endpoints for rotation

const FREE = [
  process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
  process.env.RH_RPC_URL_2,
  process.env.RH_RPC_URL_3,
].filter(Boolean);

const ALCHEMY = process.env.ALCHEMY_RPC_URL || null; // fallback, costs CU

const UA = { "content-type": "application/json", "user-agent": "rh-bubblemaps/0.1" };

async function callOne(url, method, params, timeoutMs = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST", headers: UA, signal: ac.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (r.status === 429) throw new RpcErr("rate_limited", 429);
    if (!r.ok) throw new RpcErr(`http_${r.status}`, r.status);
    const j = await r.json();
    if (j.error) throw new RpcErr(j.error.message || "rpc_error", j.error.code);
    return j.result;
  } finally { clearTimeout(t); }
}
class RpcErr extends Error { constructor(m, code) { super(m); this.code = code; } }

// Try each free endpoint; only touch Alchemy if all free ones fail (and it exists).
export async function rpc(method, params, { allowFallback = true } = {}) {
  let lastErr;
  for (const url of FREE) {
    try { return await callOne(url, method, params); }
    catch (e) { lastErr = e; }
  }
  if (allowFallback && ALCHEMY) {
    try { return await callOne(ALCHEMY, method, params); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("no_rpc");
}

// Alchemy Enhanced API — ONLY reachable via ALCHEMY (free RPC can't do it).
// Used for native-funding ("funded by same wallet") clustering in phase 2.
export async function getAssetTransfers(paramsObj) {
  if (!ALCHEMY) throw new Error("getAssetTransfers requires ALCHEMY_RPC_URL");
  return callOne(ALCHEMY, "alchemy_getAssetTransfers", [paramsObj], 45000);
}

export const usingAlchemy = () => !!ALCHEMY;
