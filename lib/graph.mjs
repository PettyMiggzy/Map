// Build a bubble-map graph from ERC-20 Transfer events.
// Pulls a token's transfer history via eth_getLogs (works on the FREE RPC), then derives
// holder balances, wallet->wallet edges, and same-block acquisition clusters (the
// bundler/sniper signal). No Alchemy needed for this layer.
//
// Two entry points share one core (`graphFromEvents`):
//   buildGraph(logs)         — from raw RPC logs (the `?live=1` path + backfill)
//   buildGraphFromRows(rows) — from stored bm_transfers rows (the DB serve path)

import { rpc } from "./rpc.mjs";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const addr = (topic) => "0x" + topic.slice(-40).toLowerCase();

// Pull all Transfer logs for `token` from `fromBlock`..latest, chunked to respect
// RPC range limits. Chunk size auto-shrinks if an endpoint complains.
export async function fetchTransfers(token, fromBlock = 0, chunk = 2_000_000) {
  const latest = parseInt(await rpc("eth_blockNumber", []), 16);
  const logs = [];
  let f = fromBlock;
  while (f <= latest) {
    let t = Math.min(f + chunk - 1, latest);
    try {
      const r = await rpc("eth_getLogs", [{
        address: token.toLowerCase(), topics: [TRANSFER_TOPIC],
        fromBlock: "0x" + f.toString(16), toBlock: "0x" + t.toString(16),
      }]);
      if (Array.isArray(r)) logs.push(...r);
      f = t + 1;
    } catch (e) {
      if (chunk > 50_000) { chunk = Math.floor(chunk / 4); continue; } // shrink & retry
      throw e;
    }
  }
  return { logs, latest };
}

// Decode raw Transfer logs into flat rows ready for Postgres (bm_transfers).
// value is kept as a base-10 string so uint256 amounts survive (BigInt -> string).
export function decodeTransferLogs(logs) {
  return logs.map((l) => ({
    block: parseInt(l.blockNumber, 16),
    logIndex: parseInt(l.logIndex || "0x0", 16),
    tx: (l.transactionHash || "").toLowerCase(),
    from: addr(l.topics[1]),
    to: addr(l.topics[2]),
    value: BigInt(l.data).toString(),
  }));
}

const eventsFromLogs = (logs) => logs.map((l) => ({
  from: addr(l.topics[1]), to: addr(l.topics[2]),
  value: BigInt(l.data), block: parseInt(l.blockNumber, 16),
  logIndex: parseInt(l.logIndex || "0x0", 16),
}));

const eventsFromRows = (rows) => rows.map((r) => ({
  from: String(r.from).toLowerCase(), to: String(r.to).toLowerCase(),
  value: BigInt(r.value), block: Number(r.block), logIndex: Number(r.logIndex),
}));

// Core: turn transfer events into { token, nodes, edges, clusters }.
function graphFromEvents(events, { token, meta = {}, pool = null, source = "free-rpc" } = {}) {
  const bal = new Map(), edges = new Map(), first = new Map();
  const bump = (m, k, v) => m.set(k, (m.get(k) || 0n) + v);
  const ordered = [...events].sort((a, b) => (a.block - b.block) || (a.logIndex - b.logIndex));
  for (const e of ordered) {
    const { from, to, value: val, block: blk } = e;
    bump(bal, from, -val); bump(bal, to, val);
    if (from !== ZERO) {
      const k = from + ">" + to, e2 = edges.get(k) || { from, to, val: 0n, count: 0 };
      e2.val += val; e2.count++; edges.set(k, e2);
    }
    if (!first.has(to)) first.set(to, blk);
    if (!first.has(from)) first.set(from, blk);
  }
  const holders = [...bal].filter(([a, b]) => b > 0n && a !== ZERO);
  const supply = holders.reduce((s, [, b]) => s + b, 0n);
  // same-block acquisition clusters
  const byBlock = new Map();
  for (const [a] of holders) { const b = first.get(a); if (b != null) (byBlock.get(b) || byBlock.set(b, []).get(b)).push(a); }
  const cluster = new Map(); let cid = 0;
  for (const [, ws] of byBlock) if (ws.length > 1) { cid++; for (const w of ws) cluster.set(w, cid); }
  const pctOf = (b) => supply > 0n ? Number((b * 100000n) / supply) / 1000 : 0;
  const nodes = holders.map(([a, b]) => ({
    id: a, bal: b.toString(), pct: pctOf(b), firstBlock: first.get(a) ?? null,
    cluster: cluster.get(a) || 0,
    tag: (a === DEAD ? "burn" : (pool && a === pool.toLowerCase()) ? "LP Pool" : null),
  }));
  const held = new Set(holders.map(([a]) => a));
  const edgeList = [...edges.values()]
    .filter((e) => held.has(e.from) || held.has(e.to))
    .map((e) => ({ from: e.from, to: e.to, val: e.val.toString(), count: e.count }));
  return {
    token: { address: token.toLowerCase(), ...meta, supply: supply.toString(), holders: holders.length },
    pool, transfers: events.length, clusters: cid, nodes, edges: edgeList, source,
  };
}

// Overlay "funded by the same wallet" clustering onto a built graph. `funding` = rows
// {wallet, funder, block} (from bm_funding). Holders sharing a funder become one cluster —
// the strongest sybil/insider link (bubblemaps-style). Adds n.funder + n.fundCluster to each
// node, a fundClusters count, and fundingEdges (funder -> wallet) for rendering.
export function attachFundingClusters(graph, funding = []) {
  const funderOf = new Map();
  for (const f of funding) { const w = String(f.wallet).toLowerCase(); if (!funderOf.has(w)) funderOf.set(w, String(f.funder).toLowerCase()); }
  const holderIds = new Set(graph.nodes.map((n) => n.id));
  const byFunder = new Map();
  for (const n of graph.nodes) { const fn = funderOf.get(n.id); if (fn) { const a = byFunder.get(fn) || byFunder.set(fn, []).get(fn); a.push(n.id); } }
  const fcluster = new Map(); let fcid = 0;
  for (const [, ws] of byFunder) if (ws.length > 1) { fcid++; for (const w of ws) fcluster.set(w, fcid); }
  for (const n of graph.nodes) { n.funder = funderOf.get(n.id) || null; n.fundCluster = fcluster.get(n.id) || 0; }
  // funding edges among displayed holders (funder shown only if it is also a holder node)
  const fundingEdges = [];
  for (const [fn, ws] of byFunder) if (ws.length > 1) for (const w of ws) fundingEdges.push({ from: fn, to: w, kind: "funding", funderIsHolder: holderIds.has(fn) });
  graph.fundClusters = fcid;
  graph.fundingEdges = fundingEdges;
  return graph;
}

// From raw RPC logs (live path / backfill).
export function buildGraph(logs, opts = {}) {
  return graphFromEvents(eventsFromLogs(logs), opts);
}

// From stored bm_transfers rows (DB serve path).
export function buildGraphFromRows(rows, opts = {}) {
  return graphFromEvents(eventsFromRows(rows), { source: "db", ...opts });
}
