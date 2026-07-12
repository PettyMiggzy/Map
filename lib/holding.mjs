// Proof-of-hold verifier core for the Sherwood Pact.
//
// Answers ONE question against the indexed transfer history: did `wallet` hold at least
// `minHold` of `token` CONTINUOUSLY across [startTs, endTs] — never dipping below, even for
// a block? A balance only falls on an OUTGOING transfer, so the window minimum is the balance
// at window-open plus the balance after each in-window outgoing transfer. We reconstruct the
// running balance from genesis (that's why the token must be indexed from its deploy block).
//
// Returns a decision plus the evidence, and a `complete` flag: if the indexer hasn't covered
// the history back to (or before) the pact start, we DON'T guess — the caller skips the pact
// and leaves it for a later run / manual review, so we never wrongly forfeit a real holder.
import { requireDb } from "./db.mjs";
import { rpc } from "./rpc.mjs";

const _tsCache = new Map();
export async function blockTimestamp(block) {
  const b = Number(block);
  if (_tsCache.has(b)) return _tsCache.get(b);
  const res = await rpc("eth_getBlockByNumber", ["0x" + b.toString(16), false]);
  const ts = res && res.timestamp != null ? parseInt(res.timestamp, 16) : null;
  _tsCache.set(b, ts);
  return ts;
}

// Earliest block we have indexed for this token (0 rows => null). Used to prove the history
// reaches back before the pact start; otherwise balanceAtStart would be understated.
async function earliestIndexedTs(db, token) {
  const rows = await db.query(
    `SELECT block FROM bm_transfers WHERE token = $1 ORDER BY block ASC LIMIT 1`, [token]
  );
  if (!rows[0]) return null;
  return blockTimestamp(Number(rows[0].block));
}

/**
 * @returns {Promise<{held:boolean, complete:boolean, balanceAtStart:string, windowMin:string,
 *                     minHold:string, transfers:number, reason:string}>}
 */
export async function heldContinuously({ wallet, token, minHold, startTs, endTs }) {
  const db = requireDb();
  const w = String(wallet).toLowerCase();
  const t = String(token).toLowerCase();
  const MH = BigInt(minHold);

  const rows = await db.query(
    `SELECT block, log_index AS li, "from" AS f, "to" AS tt, value::text AS v
     FROM bm_transfers
     WHERE token = $1 AND ("from" = $2 OR "to" = $2)
     ORDER BY block ASC, log_index ASC`,
    [t, w]
  );

  // Completeness guard: the token must be indexed from BEFORE this pact opened, or a wallet
  // that received tokens pre-index would show an understated starting balance.
  const firstTs = await earliestIndexedTs(db, t);
  if (firstTs == null || firstTs > startTs) {
    return { held: false, complete: false, balanceAtStart: "0", windowMin: "0",
      minHold: MH.toString(), transfers: rows.length,
      reason: firstTs == null ? "token not indexed yet" : "index history starts after pact start" };
  }

  // Resolve timestamps for the (bounded) set of blocks this wallet touched.
  const blocks = [...new Set(rows.map((r) => Number(r.block)))];
  const ts = {};
  for (const b of blocks) ts[b] = await blockTimestamp(b);
  const series = rows.map((r) => ({ ts: ts[Number(r.block)], f: r.f, tt: r.tt, v: r.v }));

  const d = decideFromSeries(series, w, MH, startTs, endTs);
  return {
    held: d.held, complete: true,
    balanceAtStart: d.balanceAtStart.toString(), windowMin: d.windowMin.toString(),
    minHold: MH.toString(), transfers: rows.length,
    reason: d.held ? "held >= minHold for the whole window" : "balance dipped below minHold",
  };
}

/**
 * PURE decision core (no I/O) — unit-tested + simulated in scripts/simulate-holding.mjs.
 * `series` = transfers touching `w`, each {ts, f(rom), tt(to), v(alue string)}, sorted by
 * (block, log_index). A balance only falls on an outgoing transfer, so the window minimum is
 * the balance at window-open plus the balance after each in-window transfer.
 * Transfers at exactly startTs fold into the opening balance (so an out-at-open is still caught).
 * @returns {{held:boolean, balanceAtStart:bigint, windowMin:bigint}}
 */
export function decideFromSeries(series, w, minHold, startTs, endTs) {
  const MH = BigInt(minHold);
  const min = (a, b) => (a < b ? a : b);
  let bal = 0n, balAtStart = null, windowMin = null;
  for (const r of series) {
    const rowTs = r.ts;
    if (rowTs != null && rowTs > startTs && balAtStart === null) { balAtStart = bal; windowMin = bal; }
    const delta = (r.tt === w ? BigInt(r.v) : 0n) - (r.f === w ? BigInt(r.v) : 0n);
    bal += delta;
    if (rowTs != null && rowTs > startTs && rowTs <= endTs) windowMin = windowMin === null ? bal : min(windowMin, bal);
  }
  if (balAtStart === null) { balAtStart = bal; windowMin = bal; }
  return { held: balAtStart >= MH && windowMin >= MH, balanceAtStart: balAtStart, windowMin };
}
