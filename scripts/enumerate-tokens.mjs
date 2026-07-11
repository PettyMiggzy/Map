#!/usr/bin/env node
// Whole-chain enumeration: register every ERC-20 on Robinhood Chain into bm_tokens so the
// incremental cron (api/index-cron.js) will backfill + keep each one's bubble map fresh.
// FREE (Blockscout only, $0 Alchemy CU).
//
// Usage: node scripts/enumerate-tokens.mjs [--min-holders N] [--max-pages N]
//   --min-holders  skip dust tokens with fewer holders (default env ENUM_MIN_HOLDERS or 2;
//                  a bubble map needs >1 holder to be a graph). Pass 0 for literally everything.
//   --max-pages    cap Blockscout pages (50 tokens/page); default all.
import { discoverTokens } from "../lib/discover.mjs";
import { registerToken, requireDb } from "../lib/db.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
};
const minHolders = parseInt(arg("--min-holders", process.env.ENUM_MIN_HOLDERS ?? "2"), 10);
const maxPages = parseInt(arg("--max-pages", "0"), 10) || Infinity;

requireDb(); // fail fast if BUBBLE_DATABASE_URL is missing

let seen = 0, registered = 0, skipped = 0;
for await (const t of discoverTokens({ maxPages })) {
  seen++;
  if (minHolders > 0 && (t.holdersCount ?? 0) < minHolders) { skipped++; continue; }
  await registerToken(t.token, { name: t.name, symbol: t.symbol, decimals: t.decimals });
  registered++;
  if (registered % 100 === 0) console.log(`  …${registered} registered (${seen} seen)`);
}
console.log(`done: ${registered} registered, ${skipped} skipped (<${minHolders} holders), ${seen} seen total`);
console.log("The cron (api/index-cron.js) will now backfill never-indexed tokens first.");
