/**
 * One-off diagnostic: what kind of address is your Polymarket funder
 * address, on-chain? EOA, or a proxy contract — and if a proxy, which
 * implementation it points at (EIP-1967 slot). Settles the "which
 * signatureType do I actually need" question with on-chain evidence
 * instead of guessing from docs/GitHub threads.
 *
 * Usage:
 *   npx tsx polymarket/check-wallet-type.ts 0xF0Ccace5f92Fc1d2EdD97009E0E63EE94AdB4A53
 */
import { createPublicClient, http } from "viem";
import { polygon } from "viem/chains";

// Standard EIP-1967 implementation storage slot — keccak256("eip1967.proxy.implementation") - 1.
const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bb" as const;

// Reference implementations mentioned in the clob-client-v2 issue threads,
// for eyeballing the result against. Add to this as you learn more.
const KNOWN: Record<string, string> = {
  "0xd9db270c1b5e3bd161e8c8503c55ceabee709552":
    "Gnosis Safe master copy (v1.3.0) — classic proxy wallet, signatureType 2 (POLY_GNOSIS_SAFE)",
};

async function main() {
  const address = process.argv[2];
  if (!address) {
    console.error("usage: npx tsx check-wallet-type.ts <address>");
    process.exit(1);
  }

  const client = createPublicClient({ chain: polygon, transport: http() });

  const code = await client.getBytecode({ address: address as `0x${string}` });
  if (!code || code === "0x") {
    console.log(`${address} has NO CODE — it's a plain EOA.`);
    console.log(
      `If this is your POLY_PRIVATE_KEY's own address, you're on the direct-EOA path ` +
        `(signatureType 0) — assuming Polymarket's order-routing API allows it for this account ` +
        `(the smoke test will tell you either way).`
    );
    return;
  }

  console.log(`${address} IS A CONTRACT (${(code.length - 2) / 2} bytes of code).`);

  const implRaw = await client.getStorageAt({
    address: address as `0x${string}`,
    slot: EIP1967_IMPL_SLOT,
  });
  const impl = implRaw ? (`0x${implRaw.slice(-40)}` as const) : null;

  if (impl && impl !== "0x0000000000000000000000000000000000000000") {
    console.log(`EIP-1967 implementation slot points to: ${impl}`);
    const known = KNOWN[impl.toLowerCase()];
    console.log(
      known
        ? `  -> ${known}`
        : `  -> Unrecognized implementation. Compare this against what Settings shows you ` +
            `and the addresses discussed in github.com/Polymarket/clob-client-v2 issue #75 ` +
            `to determine if this is a POLY_1271 deposit wallet specifically.`
    );
  } else {
    console.log(
      `No EIP-1967 implementation slot set — not a standard transparent/UUPS proxy. ` +
        `Check the "Contract" tab on polygonscan.com/address/${address} directly for the ` +
        `verified contract name — that'll say plainly if it's a deposit wallet, Safe, or something else.`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
