// Neon Postgres client for the bubble-map indexer.
//
// IMPORTANT: this must point at a SEPARATE Neon database from the catboy bot.
// A chain-wide indexer can burn connections/storage — never share the bot's DATABASE_URL.
// The env var is deliberately named BUBBLE_DATABASE_URL so it can't collide with it.
//
// Uses @neondatabase/serverless (HTTP driver): works both in Vercel functions and in the
// Node CLI backfill, no pool to manage. Viewer traffic is served from here, never Alchemy.
import { neon } from "@neondatabase/serverless";

const URL = process.env.BUBBLE_DATABASE_URL;

export const hasDb = () => !!URL;
export const sql = URL ? neon(URL) : null;

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
        slice.map((r) => r.from),
        slice.map((r) => r.to),
        slice.map((r) => r.value),
      ]
    );
    written += slice.length;
  }
  return written;
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

// Tokens the cron should keep fresh (or list in a token picker).
export async function listActiveTokens(limit = 50) {
  const db = requireDb();
  return db.query(
    `SELECT token, symbol, name FROM bm_tokens WHERE active = true ORDER BY updated_at ASC LIMIT $1`,
    [limit]
  );
}
