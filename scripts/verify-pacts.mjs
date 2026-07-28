// Sherwood Pact auto-verifier (the automated oracle).
//
// Reads every OPEN pact whose hold window has ended, asks the indexed transfer history whether
// that wallet held its pledge continuously, and submits verify(id, held, reward) as the oracle
// key. Non-holders are forfeited; holders are marked payable (refund + reward). Idempotent:
// once a pact leaves Open it's no longer returned, so re-runs are safe.
//
// Run as a CLI (node scripts/verify-pacts.mjs) or import runVerifier() from the Vercel cron.
//
// Env:
//   RH_RPC_URL            free RPC (default mainnet)             PACT_ADDRESS   SherwoodPact 0x…
//   STAG_ADDRESS          token the pact pledges (default $STAG) ORACLE_KEY     oracle wallet private key
//   REWARD_ETH            reward paid on held=true (default 0 → just the refund)
//   PACT_MAX_SCAN         max pacts scanned per run (default 200)
//   BUBBLE_DATABASE_URL   the indexer's Neon DB (holding history)
//   DRY_RUN=1             report decisions, send NO transactions (for audits/sims)
import { ethers } from "ethers";
import { heldContinuously } from "../lib/holding.mjs";

const STAG_DEFAULT = "0xcC142366735c882F7885d3c747db99e45E13E453";
const PACT_ABI = [
  "function openPactsPastWindow(uint256,uint256) view returns (uint256[])",
  "function pacts(uint256) view returns (address wallet,uint256 minHold,uint64 start,uint64 duration,uint256 entryPaid,uint256 payout,uint8 status,uint64 reclaimGrace)",
  "function maxReward() view returns (uint256)",
  "function oracle() view returns (address)",
  "function verify(uint256,bool,uint256)",
];
const ERC20_ABI = ["function decimals() view returns (uint8)"];

export async function runVerifier(opts = {}) {
  const RPC = opts.rpc || process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
  const PACT = opts.pact || process.env.PACT_ADDRESS;
  const STAG = opts.stag || process.env.STAG_ADDRESS || STAG_DEFAULT;
  const KEY = opts.key || process.env.ORACLE_KEY;
  const REWARD = ethers.parseEther(String(opts.rewardEth ?? process.env.REWARD_ETH ?? "0"));
  const MAX = parseInt(opts.maxScan || process.env.PACT_MAX_SCAN || "500", 10);
  const DRY = opts.dryRun ?? (process.env.DRY_RUN === "1");
  if (!PACT) throw new Error("PACT_ADDRESS not set");
  if (!DRY && !KEY) throw new Error("ORACLE_KEY not set (or run DRY_RUN=1)");

  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const signer = KEY ? new ethers.Wallet(KEY, provider) : null;
  const pact = new ethers.Contract(PACT, PACT_ABI, signer || provider);

  // sanity: is our key actually the oracle?
  if (signer) {
    const oracle = await pact.oracle();
    if (oracle.toLowerCase() !== (await signer.getAddress()).toLowerCase())
      throw new Error(`ORACLE_KEY (${await signer.getAddress()}) is not the pact oracle (${oracle})`);
  }
  // $STAG must be positively confirmed as 18 decimals (minHold is 1e18-scaled). Fail CLOSED:
  // if the call errors we abort the run rather than proceed on an assumption.
  {
    let d;
    try { d = Number(await new ethers.Contract(STAG, ERC20_ABI, provider).decimals()); }
    catch (e) { throw new Error(`could not read ${STAG} decimals to confirm 18: ${e.shortMessage || e.message}`); }
    if (d !== 18) throw new Error(`token decimals ${d} != 18 — holding math assumes 18`);
  }

  const maxReward = await pact.maxReward();
  const reward = REWARD > maxReward ? maxReward : REWARD;
  const now = Math.floor(Date.now() / 1000);
  const ids = await pact.openPactsPastWindow(0, MAX);
  const out = [];

  for (const idB of ids) {
    const id = Number(idB);
    try {
      const p = await pact.pacts(id);
      const startTs = Number(p.start), endTs = startTs + Number(p.duration), grace = Number(p.reclaimGrace);
      const res = await heldContinuously({ wallet: p.wallet, token: STAG, minHold: p.minHold.toString(), startTs, endTs });

      if (!res.complete) { out.push({ id, action: "skip", reason: `indexer incomplete: ${res.reason}` }); continue; }

      if (res.held) {
        if (DRY) { out.push({ id, action: "verify-held", held: true, reward: ethers.formatEther(reward), evidence: res }); continue; }
        const tx = await pact.verify(id, true, reward);
        await tx.wait();
        out.push({ id, action: "verified-held", tx: tx.hash, reward: ethers.formatEther(reward) });
      } else {
        // Past window+grace we CANNOT forfeit (contract hands it to the holder's reclaim). Skip.
        if (now >= endTs + grace) { out.push({ id, action: "skip", reason: "past grace — holder reclaims, oracle can't forfeit" }); continue; }
        if (DRY) { out.push({ id, action: "forfeit", held: false, evidence: res }); continue; }
        const tx = await pact.verify(id, false, 0);
        await tx.wait();
        out.push({ id, action: "forfeited", tx: tx.hash });
      }
    } catch (e) {
      out.push({ id, action: "error", error: String(e.shortMessage || e.reason || e.message || e) });
    }
  }
  return { scanned: ids.length, dryRun: !!DRY, reward: ethers.formatEther(reward), results: out };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  runVerifier().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((e) => { console.error("verifier error:", e.message || e); process.exit(1); });
}
