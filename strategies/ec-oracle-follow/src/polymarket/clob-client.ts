/**
 * Authenticated Polymarket CLOB client — CLOB V2.
 *
 * IMPORTANT CONTEXT (read polymarket/README.md before debugging this):
 * The V1 package (@polymarket/clob-client) stopped working April 22, 2026.
 * This targets @polymarket/clob-client-v2 instead, which uses viem rather
 * than ethers for signing.
 *
 * SIGNATURE TYPE: this tries EOA (type 0) first — the simple "bot trades
 * its own funded wallet directly" path. As of ~May 2026 Polymarket moved
 * new accounts to a "deposit wallet" model (type 3 / POLY_1271) and EOA
 * trading now requires an allowlisted EOA. If this fails with a wallet-type
 * or allowlist error, that's the signal you need the deposit-wallet flow
 * instead (see README) — don't assume it's a bug in this file first.
 *
 * PREREQUISITE (one-time, outside this code, unchanged from before): the
 * funding wallet needs USDC.e on Polygon and the CTF Exchange / Conditional
 * Tokens approvals set, same as a normal Polymarket UI login does on first
 * use.
 */
import { ClobClient, SignatureTypeV2, type ApiKeyCreds } from "@polymarket/clob-client-v2";
import { createWalletClient, http, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const CHAIN_ID = 137; // Polygon

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`polymarket: missing required env var ${name}`);
  return v;
}

function buildSigner(): WalletClient {
  const privateKey = requireEnv("POLY_PRIVATE_KEY") as `0x${string}`;
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({ account, chain: polygon, transport: http() });
}

let cached: ClobClient | null = null;

/**
 * Returns a fully authenticated ClobClient. Safe to call repeatedly — only
 * does the credential round-trip once per process.
 *
 * POLY_SIGNATURE_TYPE lets you flip to the deposit-wallet path (3) via env
 * without touching code, once/if that's confirmed necessary — see README.
 */
export async function getClobClient(): Promise<ClobClient> {
  if (cached) return cached;

  const host = process.env.POLY_CLOB_HOST ?? "https://clob.polymarket.com";
  const signer = buildSigner();
  const signatureType = Number(process.env.POLY_SIGNATURE_TYPE ?? SignatureTypeV2.EOA);
  const funderAddress = process.env.POLY_FUNDER_ADDRESS ?? signer.account!.address;

  // Bootstrap client (no creds yet) just to derive/create API credentials.
  const bootstrap = new ClobClient({ host, chain: CHAIN_ID, signer });
  const creds: ApiKeyCreds = await bootstrap.createOrDeriveApiKey();

  // NOTE: verify `funderAddress` is the exact field name your installed
  // version's types expect — check node_modules/@polymarket/clob-client-v2's
  // .d.ts or your editor's autocomplete. Doc snippets for this constructor
  // have been inconsistent between releases; the type definitions are the
  // source of truth, not this comment.
  cached = new ClobClient({ host, chain: CHAIN_ID, signer, creds, signatureType, funderAddress });
  return cached;
}