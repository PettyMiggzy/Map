// Simulation / adversarial test for the Sherwood Pact holding oracle (lib/holding.mjs).
//
// Generates thousands of randomized transfer histories + windows and checks the pure decision
// core (decideFromSeries) against an INDEPENDENT brute-force reference that recomputes the
// wallet balance from scratch at every relevant instant. Any mismatch = a real oracle bug.
//
//   node scripts/simulate-holding.mjs [trials]
import { decideFromSeries } from "../lib/holding.mjs";

// deterministic PRNG (no Date.now / Math.random → reproducible failures)
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const W = "0xwallet";
const OTHER = "0xother";

// Independent reference: balance(t) = sum of deltas with ts <= t, recomputed fresh each call.
// True window-min = min of balance over every instant in [s,e]; balance is a step function that
// only changes at event timestamps, so sampling {s} ∪ {event ts in (s,e]} ∪ {e} is exact.
function refDecide(series, minHold, s, e) {
  const MH = BigInt(minHold);
  const balAt = (t) => series.reduce((acc, r) =>
    acc + (r.ts != null && r.ts <= t ? ((r.tt === W ? BigInt(r.v) : 0n) - (r.f === W ? BigInt(r.v) : 0n)) : 0n), 0n);
  // sample points: window open, every event strictly inside (s,e], and the close
  const pts = new Set([s, e]);
  for (const r of series) if (r.ts != null && r.ts > s && r.ts <= e) pts.add(r.ts);
  let mn = null;
  for (const t of pts) { const b = balAt(t); mn = mn === null ? b : (b < mn ? b : mn); }
  // balAtStart per our semantics = balance at exactly s (folds in at-open transfers)
  const balStart = balAt(s);
  const held = balStart >= MH && (mn === null ? balStart >= MH : mn >= MH);
  return { held, windowMin: mn === null ? balStart : mn };
}

function genSeries(rnd) {
  const n = Math.floor(rnd() * 12); // 0..11 transfers
  const evts = [];
  let block = 1 + Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) {
    block += 1 + Math.floor(rnd() * 8);
    const ts = block * 12; // ~12s blocks
    const incoming = rnd() < 0.5;
    const v = BigInt(1 + Math.floor(rnd() * 5)) * 10n ** 18n * BigInt(1 + Math.floor(rnd() * 3));
    evts.push({ ts, f: incoming ? OTHER : W, tt: incoming ? W : OTHER, v: v.toString() });
  }
  // ensure sorted by ts (block); intra-order stable
  evts.sort((a, b) => a.ts - b.ts);
  return evts;
}

function run(trials) {
  const rnd = mulberry32(1337);
  let mismatches = 0, held = 0, notHeld = 0, edgeAtOpen = 0;
  for (let i = 0; i < trials; i++) {
    const series = genSeries(rnd);
    const tsAll = series.map((e) => e.ts);
    const lo = tsAll.length ? Math.min(...tsAll) - 24 : 0;
    const hi = tsAll.length ? Math.max(...tsAll) + 24 : 1000;
    let s = lo + Math.floor(rnd() * Math.max(1, hi - lo));
    // occasionally snap the window OPEN exactly onto an event ts to probe boundaries
    if (series.length && rnd() < 0.4) s = series[Math.floor(rnd() * series.length)].ts;
    // a real pact window is always start + duration, so end > start by construction
    const e = s + 1 + Math.floor(rnd() * Math.max(1, hi - s + 48));
    if (series.some((r) => r.ts === s)) edgeAtOpen++;
    const minHold = (BigInt(Math.floor(rnd() * 20)) * 10n ** 18n).toString();

    const got = decideFromSeries(series, W, minHold, s, e);
    const ref = refDecide(series, minHold, s, e);
    if (got.held !== ref.held || got.windowMin !== ref.windowMin) {
      mismatches++;
      if (mismatches <= 5) {
        console.error(`MISMATCH #${mismatches} trial ${i}: got held=${got.held} min=${got.windowMin} | ref held=${ref.held} min=${ref.windowMin}`);
        console.error(`  window [${s},${e}] minHold=${minHold}`);
        console.error(`  series=${JSON.stringify(series)}`);
      }
    }
    got.held ? held++ : notHeld++;
  }
  console.log(`trials=${trials}  held=${held}  notHeld=${notHeld}  windowsSnappedToEvent=${edgeAtOpen}  MISMATCHES=${mismatches}`);
  if (mismatches) { console.error("\n❌ oracle holding logic diverged from reference"); process.exit(1); }
  console.log("✅ holding oracle matches the brute-force reference on every trial");
}

run(parseInt(process.argv[2] || "20000", 10));
