// Neon Postgres client for the bubble-map indexer.
//
// IMPORTANT: this must point at a SEPARATE Neon database from the catboy bot.
// A chain-wide indexer can burn connections/storage — never share the bot's DATABASE_URL.
// The env var is deliberately named BUBBLE_DATABASE_URL so it can't collide with it.
//
// Uses @neondatabase/serverless (HTTP driver): works both in Vercel functions and in the
// Node CLI backfill, no pool to manage. Viewer traffic is served from here, never Alchemy.
import { Pool, neonConfig } from "@neondatabase/serverless";

const URL = process.env.BUBBLE_DATABASE_URL;

// Run pool queries over HTTP fetch (stateless, serverless-friendly — no WebSocket needed).
neonConfig.poolQueryViaFetch = true;

// The whole codebase calls db.query(text, params) and expects a rows ARRAY back. The neon
// http tagged-template (`neon()`) doesn't expose .query in this version, so wrap a Pool and
// return `.rows` directly to keep that contract.
const _pool = URL ? new Pool({ connectionString: URL }) : null;
export const hasDb = () => !!URL;
export const sql = _pool ? { query: async (text, params = []) => (await _pool.query(text, params)).rows } : null;

export function requireDb() {
  if (!sql) {
    throw new Error(
      "BUBBLE_DATABASE_URL is not set. Point it at the SEPARATE Neon bubble-map DB " +
      "(never the catboy bot's database). See HANDOFF.md / README.md."
    );
  }
  return sql;
}

// ---- writes -------------------------------------------------------------

// Upsert decoded transfer rows in batches. Rows: {block, logIndex, tx, from, to, value(string)}.
// ON CONFLICT DO NOTHING makes re-runs and overlapping block ranges idempotent.
export async function upsertTransfers(token, rows, batch = 1000) {
  if (!rows.length) return 0;
  const db = requireDb();
  const t = token.toLowerCase();
  let written = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    await db.query(
      `INSERT INTO bm_transfers (token, block, log_index, tx, "from", "to", value)
       SELECT $1, * FROM unnest(
         $2::bigint[], $3::int[], $4::text[], $5::text[], $6::text[], $7::numeric[]
       ) AS t(block, log_index, tx, "from", "to", value)
       ON CONFLICT (token, block, log_index) DO NOTHING`,
      [
        t,
        slice.map((r) => r.block),
        slice.map((r) => r.logIndex),
        slice.map((r) => r.tx),
        slice.map((r) => r.from.toLowerCase()),  // normalize: readers + balance math are case-sensitive
        slice.map((r) => r.to.toLowerCase()),
        slice.map((r) => r.value),
      ]
    );
    written += slice.length;
  }
  return written;
}

// Native-ETH funding edges (wallet <- funder). Powers "funded by the same wallet" clustering.
export async function upsertFunding(rows, batch = 1000) {
  if (!rows.length) return 0;
  const db = requireDb();
  for (let i = 0; i < rows.length; i += batch) {
    const s = rows.slice(i, i + batch);
    await db.query(
      `INSERT INTO bm_funding (wallet, funder, block)
       SELECT * FROM unnest($1::text[], $2::text[], $3::bigint[]) AS t(wallet, funder, block)
       ON CONFLICT (wallet, funder, block) DO NOTHING`,
      [s.map((r) => r.wallet.toLowerCase()), s.map((r) => r.funder.toLowerCase()), s.map((r) => Number(r.block))]
    );
  }
  return rows.length;
}

// Funding rows for a set of wallets (the graph's holder ids), earliest first.
export async function getFunding(wallets) {
  if (!wallets.length) return [];
  const db = requireDb();
  return db.query(
    `SELECT wallet, funder, block FROM bm_funding WHERE wallet = ANY($1::text[]) ORDER BY block ASC`,
    [wallets.map((w) => String(w).toLowerCase())]
  );
}

// Address labels (global, store-once): 'LP Pool' | 'Contract' | 'EOA'. See db/schema.sql.
export async function getLabels(addresses) {
  if (!addresses.length) return new Map();
  const db = requireDb();
  const rows = await db.query(
    `SELECT address, label FROM bm_labels WHERE address = ANY($1::text[])`,
    [addresses.map((a) => String(a).toLowerCase())]
  );
  return new Map(rows.map((r) => [r.address, r.label]));
}

export async function upsertLabels(rows) {
  if (!rows.length) return 0;
  const db = requireDb();
  let n = 0;
  for (const { address, label } of rows) {
    await db.query(
      `INSERT INTO bm_labels (address, label, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (address) DO UPDATE SET label = EXCLUDED.label, updated_at = now()`,
      [String(address).toLowerCase(), label]
    );
    n++;
  }
  return n;
}

export async function setCursor(scope, lastBlock) {
  const db = requireDb();
  await db.query(
    `INSERT INTO bm_cursor (scope, last_block, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (scope) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = now()`,
    [scope.toLowerCase(), lastBlock]
  );
}

export async function getCursor(scope) {
  const db = requireDb();
  const rows = await db.query(`SELECT last_block FROM bm_cursor WHERE scope = $1`, [
    scope.toLowerCase(),
  ]);
  return rows[0] ? Number(rows[0].last_block) : 0;
}

// Upsert token metadata + latest summary (holders/supply/transfers).
export async function upsertToken(token, { name, symbol, decimals, holders, supply, transfers }) {
  const db = requireDb();
  await db.query(
    `INSERT INTO bm_tokens (token, name, symbol, decimals, holders, supply, transfers, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (token) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, bm_tokens.name),
       symbol = COALESCE(EXCLUDED.symbol, bm_tokens.symbol),
       decimals = COALESCE(EXCLUDED.decimals, bm_tokens.decimals),
       holders = EXCLUDED.holders,
       supply = EXCLUDED.supply,
       transfers = EXCLUDED.transfers,
       updated_at = now()`,
    [
      token.toLowerCase(),
      name ?? null,
      symbol ?? null,
      decimals ?? null,
      holders ?? null,
      supply ?? null,
      transfers ?? null,
    ]
  );
}

// ---- reads (API serve path) --------------------------------------------

// All stored transfers for a token, ordered for deterministic graph rebuilds.
export async function getTransfers(token) {
  const db = requireDb();
  return db.query(
    `SELECT block, log_index AS "logIndex", tx, "from", "to", value::text AS value
     FROM bm_transfers WHERE token = $1 ORDER BY block ASC, log_index ASC`,
    [token.toLowerCase()]
  );
}

export async function getTokenMeta(token) {
  const db = requireDb();
  const rows = await db.query(
    `SELECT token, name, symbol, decimals FROM bm_tokens WHERE token = $1`,
    [token.toLowerCase()]
  );
  return rows[0] || null;
}

// Tokens the cron should advance next. Ordered by INDEXING recency (bm_cursor.updated_at),
// NULLS FIRST so never-indexed tokens (no cursor yet) are backfilled before we round-robin
// the rest. This is what makes whole-chain backfill drain fairly instead of starving new tokens.
export async function listActiveTokens(limit = 50) {
  const db = requireDb();
  return db.query(
    `SELECT t.token, t.symbol, t.name
     FROM bm_tokens t
     LEFT JOIN bm_cursor c ON c.scope = t.token
     WHERE t.active = true
     ORDER BY c.updated_at ASC NULLS FIRST
     LIMIT $1`,
    [limit]
  );
}

// Register a token in the whole-chain registry (from enumeration). Non-destructive:
// only fills identity fields when missing and never touches our computed
// holders/supply/transfers summary. Re-runnable; re-activates a previously disabled token.
export async function registerToken(token, { name, symbol, decimals } = {}) {
  const db = requireDb();
  await db.query(
    `INSERT INTO bm_tokens (token, name, symbol, decimals, active, updated_at)
     VALUES ($1, $2, $3, $4, true, now())
     ON CONFLICT (token) DO UPDATE SET
       name = COALESCE(bm_tokens.name, EXCLUDED.name),
       symbol = COALESCE(bm_tokens.symbol, EXCLUDED.symbol),
       decimals = COALESCE(bm_tokens.decimals, EXCLUDED.decimals),
       active = true`,
    [token.toLowerCase(), name ?? null, symbol ?? null, decimals ?? null]
  );
}

// Token list for the frontend picker / whole-chain browse. Indexed tokens first
// (holders desc), then registered-but-not-yet-indexed.
export async function listTokens({ limit = 100, offset = 0, q = null } = {}) {
  const db = requireDb();
  const like = q ? `%${q.toLowerCase()}%` : null;
  return db.query(
    `SELECT token, name, symbol, decimals, holders, transfers, updated_at
     FROM bm_tokens
     WHERE active = true
       AND ($3::text IS NULL OR lower(token) LIKE $3 OR lower(symbol) LIKE $3 OR lower(name) LIKE $3)
     ORDER BY (holders IS NULL), holders DESC NULLS LAST, updated_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset, like]
  );
}
