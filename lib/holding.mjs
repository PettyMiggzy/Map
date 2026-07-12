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
import { requireDb, getCursor } from "./db.mjs";
import { rpc } from "./rpc.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const _tsCache = new Map();
export async function blockTimestamp(block) {
  const b = Number(block);
  if (_tsCache.has(b)) return _tsCache.get(b);
  const res = await rpc("eth_getBlockByNumber", ["0x" + b.toString(16), false]);
  const ts = res && res.timestamp != null ? parseInt(res.timestamp, 16) : null;
  if (ts != null) _tsCache.set(b, ts); // never cache a transient null (would poison later reads)
  return ts;
}

// Prove the indexed history is good enough to trust a decision on this window:
//  (a) genesis captured — the earliest indexed row is a mint (from == 0x0), OR its timestamp
//      is already before the pact opened (so no pre-window receive is missing), AND
//  (b) the index cursor has advanced PAST the window end (so no in-window dip is un-indexed).
// If either fails we return complete:false and the caller SKIPS (never guesses a forfeit/payout).
async function coverage(db, token, startTs, endTs) {
  const first = await db.query(
    `SELECT block, "from" AS f FROM bm_transfers WHERE token = $1 ORDER BY block ASC, log_index ASC LIMIT 1`, [token]
  );
  if (!first[0]) return { ok: false, reason: "token not indexed yet" };
  const firstTs = await blockTimestamp(Number(first[0].block));
  const genesisCaptured = first[0].f === ZERO || (firstTs != null && firstTs <= startTs);
  if (!genesisCaptured) return { ok: false, reason: "index history may start after token deploy" };
  const cursor = await getCursor(token);
  const cursorTs = cursor ? await blockTimestamp(cursor) : null;
  if (cursorTs == null || cursorTs < endTs) return { ok: false, reason: "index has not reached the window end yet" };
  return { ok: true };
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

  // Completeness guard first — never guess on partial data.
  const cov = await coverage(db, t, startTs, endTs);
  if (!cov.ok) return { held: false, complete: false, balanceAtStart: "0", windowMin: "0",
    minHold: MH.toString(), transfers: 0, reason: cov.reason };

  // lower("from"/"to") keeps the read correct even against any legacy mixed-case rows.
  const rows = await db.query(
    `SELECT block, log_index AS li, lower("from") AS f, lower("to") AS tt, value::text AS v
     FROM bm_transfers
     WHERE token = $1 AND (lower("from") = $2 OR lower("to") = $2)
     ORDER BY block ASC, log_index ASC`,
    [t, w]
  );

  // Resolve timestamps for the (bounded) set of blocks this wallet touched.
  const blocks = [...new Set(rows.map((r) => Number(r.block)))];
  const ts = {};
  for (const b of blocks) ts[b] = await blockTimestamp(b);
  // A null timestamp on any of the wallet's blocks means we'd have to guess whether its transfer
  // lands in the window — refuse and skip rather than feed a null-ts row into the reconstruction.
  if (blocks.some((b) => ts[b] == null)) return { held: false, complete: false, balanceAtStart: "0",
    windowMin: "0", minHold: MH.toString(), transfers: rows.length, reason: "unresolved block timestamp — retry" };
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
