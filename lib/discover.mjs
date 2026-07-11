// Whole-chain token discovery via Blockscout (FREE, $0 Alchemy CU).
// Paginates /api/v2/tokens?type=ERC-20 using Blockscout's opaque `next_page_params`
// cursor and yields normalized token records for the registry (bm_tokens).
const BS = process.env.BLOCKSCOUT_URL || "https://robinhoodchain.blockscout.com";

const num = (v) => (v == null ? null : Number(v));
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Fetch one page with retry/backoff. Blockscout occasionally returns transient 5xx/429 mid-crawl;
// a single flaky page must not abort a whole-chain enumeration of hundreds of pages.
async function fetchPage(params, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BS}/api/v2/tokens?${params}`, { headers: { "user-agent": "rh-bubblemaps" } });
      if (r.status === 429 || r.status >= 500) throw new Error(`blockscout ${r.status}`);
      if (!r.ok) throw new Error(`blockscout ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(500 * 2 ** i); // 0.5s, 1s, 2s
    }
  }
  throw lastErr;
}

// Async generator over every ERC-20 on the chain, newest/highest-cap first
// (Blockscout's default order). Stops when there is no next page or maxPages is hit.
export async function* discoverTokens({ type = "ERC-20", maxPages = Infinity } = {}) {
  let params = new URLSearchParams({ type });
  let page = 0;
  while (page < maxPages) {
    const j = await fetchPage(params);
    const items = j.items || [];
    for (const it of items) {
      const address = it.address_hash || it.address;
      if (!address) continue;
      yield {
        token: address.toLowerCase(),
        name: it.name ?? null,
        symbol: it.symbol ?? null,
        decimals: it.decimals != null ? parseInt(it.decimals, 10) : null,
        holdersCount: num(it.holders_count ?? it.holders), // Blockscout all-time holder count
        totalSupply: it.total_supply ?? null,
      };
    }
    page++;
    const next = j.next_page_params;
    if (!next || !items.length) break;
    params = new URLSearchParams({ type, ...Object.fromEntries(
      Object.entries(next).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
    ) });
  }
}
