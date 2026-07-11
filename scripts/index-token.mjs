#!/usr/bin/env node
// Backfill one token's bubble-map graph from the FREE RPC.
// Usage: node scripts/index-token.mjs 0x<token> [fromBlock]
//
// If BUBBLE_DATABASE_URL is set -> upserts into Postgres (bm_transfers/bm_cursor/bm_tokens)
// so /api/bubblemap can serve it from the DB at $0 Alchemy CU. Otherwise falls back to
// writing data/<sym>-graph.json (the no-DB prototype path).
import { fetchTransfers, buildGraph, decodeTransferLogs } from "../lib/graph.mjs";
import { tokenMeta } from "../lib/meta.mjs";
import { hasDb, upsertTransfers, setCursor, upsertToken } from "../lib/db.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const token = (process.argv[2] || "").toLowerCase();
const fromBlock = parseInt(process.argv[3] || "0", 10);
if (!token) { console.error("usage: index-token.mjs 0x<token> [fromBlock]"); process.exit(1); }

console.log(`fetching transfers (free RPC) from block ${fromBlock}…`);
const { logs, latest } = await fetchTransfers(token, fromBlock);
console.log(`  ${logs.length} transfers, head block ${latest}`);
const m = await tokenMeta(token);
const g = buildGraph(logs, { token, meta: m });
console.log(`  nodes ${g.nodes.length}  edges ${g.edges.length}  clusters ${g.clusters}`);

if (hasDb()) {
  const rows = decodeTransferLogs(logs);
  const n = await upsertTransfers(token, rows);
  await setCursor(token, latest);
  await upsertToken(token, {
    ...m, holders: g.token.holders, supply: g.token.supply, transfers: g.transfers,
  });
  console.log(`  DB: upserted ${n} transfers, cursor -> ${latest}, token meta saved (${m.symbol || "?"})`);
} else {
  mkdirSync("data", { recursive: true });
  const sym = (m.symbol || "token").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const out = `data/${sym}-graph.json`;
  writeFileSync(out, JSON.stringify(g));
  console.log(`  no BUBBLE_DATABASE_URL -> wrote ${out} (prototype JSON path)`);
}
