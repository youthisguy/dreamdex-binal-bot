/**
 * One-time ERC20 approve() for the bot's mainnet collateral token (USDso).
 *
 * IMPORTANT — read before running: if SPENDER_ADDRESS is a per-market pool
 * (not a stable router/module contract), this only unblocks the market that
 * just failed. The next market window gets a NEW pool address with zero
 * allowance, and you'll hit ERC20InsufficientAllowance again. See the note
 * at the bottom of this file for the real, persistent fix.
 *
 * Usage:
 *   PRIVATE_KEY=0x... SPENDER_ADDRESS=0x... node scripts/approve.mjs
 *   PRIVATE_KEY=0x... SPENDER_ADDRESS=0x... AMOUNT_USDSO=1000 node scripts/approve.mjs
 *   PRIVATE_KEY=0x... SPENDER_ADDRESS=0x... MAX=true node scripts/approve.mjs   # infinite approval
 */
import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL ?? "https://api.infra.mainnet.somnia.network";
// USDso, mainnet, 18 decimals — from packages/ec-core/src/addresses.ts
const COLLATERAL_ADDRESS = "0x00000022dA000002656c64D9eA6011ea952D008A";
const DECIMALS = 18;

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const SPENDER_ADDRESS = process.env.SPENDER_ADDRESS;
const AMOUNT_USDSO = process.env.AMOUNT_USDSO ?? "1000"; // default: a bounded, not-infinite allowance
const USE_MAX = (process.env.MAX ?? "false").toLowerCase() === "true";

if (!PRIVATE_KEY) throw new Error("Set PRIVATE_KEY — the same wallet the bot trades from.");
if (!SPENDER_ADDRESS || !ethers.isAddress(SPENDER_ADDRESS)) {
  throw new Error("Set SPENDER_ADDRESS to a valid address — the contract from the InsufficientAllowance revert.");
}

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const token = new ethers.Contract(COLLATERAL_ADDRESS, ERC20_ABI, wallet);

  // Sanity-check we're actually pointed at USDso, not a stale/wrong address —
  // cheap to verify, expensive to find out wrong after broadcasting on mainnet.
  const [symbol, onchainDecimals] = await Promise.all([token.symbol(), token.decimals()]);
  console.log(`Token: ${symbol}, decimals: ${onchainDecimals} (expected 18)`);
  if (Number(onchainDecimals) !== DECIMALS) {
    throw new Error(`Decimals mismatch — expected ${DECIMALS}, contract reports ${onchainDecimals}. Stop and verify COLLATERAL_ADDRESS before proceeding.`);
  }

  const before = await token.allowance(wallet.address, SPENDER_ADDRESS);
  console.log(`Current allowance for ${SPENDER_ADDRESS}: ${ethers.formatUnits(before, DECIMALS)} ${symbol}`);

  const amount = USE_MAX
    ? ethers.MaxUint256
    : ethers.parseUnits(AMOUNT_USDSO, DECIMALS);

  console.log(
    USE_MAX
      ? `Approving UNLIMITED allowance for ${SPENDER_ADDRESS} — this spender can pull any amount, any time, forever, until you manually revoke it.`
      : `Approving ${AMOUNT_USDSO} ${symbol} for ${SPENDER_ADDRESS}.`,
  );

  const tx = await token.approve(SPENDER_ADDRESS, amount);
  console.log(`Submitted: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}.`);

  const after = await token.allowance(wallet.address, SPENDER_ADDRESS);
  console.log(`New allowance: ${ethers.formatUnits(after, DECIMALS)} ${symbol}`);
}

main().catch((e) => {
  console.error("approve.mjs failed:", e.message ?? e);
  process.exit(1);
});

/**
 * ON THE PERSISTENT-FIX QUESTION:
 *
 * If SPENDER_ADDRESS here is a per-market pool (recycled per window, per
 * ec-core's own docs), this script needs re-running on every new market —
 * not viable for unattended live trading. Two real fixes, not mutually
 * exclusive:
 *
 * 1. Check whether ec-core's placeLimit/orders.ts (packages/ec-core/src/
 *    orders.ts) already contains its own approve-if-needed logic that was
 *    simply never triggered here (e.g. gated behind a flag, or skipped on
 *    a fresh wallet with zero prior approvals). If so, the fix might be a
 *    config flag, not a new script at all.
 *
 * 2. If there's a genuinely persistent contract in front of every pool
 *    (collateralRouter, 0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C, is the
 *    most likely candidate by name — a "router" is the standard pattern for
 *    exactly this problem), approve THAT once instead of each pool. Try:
 *      SPENDER_ADDRESS=0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C node scripts/approve.mjs
 *    then watch whether the NEXT market window trades without a fresh
 *    InsufficientAllowance error. If it does, collateralRouter was the
 *    right target all along and one approval covers every future market.
 */