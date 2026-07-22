/**
 * Prove that a signature THIS CODE produces is redeemable — without spending.
 *
 * Run:  pnpm -F @firm/procurer verify-signing
 *
 * `transferWithAuthorization` is executed by the vendor's relayer, not by us, so
 * a static `eth_call` of it exercises the token's real signature check against a
 * real chain: a wrong EIP-712 domain, a wrong typehash or a malformed v/r/s all
 * revert, and a correct authorization returns cleanly. Nothing is broadcast, no
 * gas is spent, no state changes.
 *
 * This deliberately drives `localSigner` itself rather than reimplementing the
 * signing steps. A script that rebuilt the logic would only prove the approach
 * works; this proves the shipped code path works.
 *
 * The authorization is addressed to our own wallet, so even the hypothetical
 * transfer this describes would be a no-op.
 */

import { createPublicClient, encodeFunctionData, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { chainIdFromNetwork, rpcUrlFor } from "../src/chain.js";
import { localSigner, walletKeyFromEnv } from "../src/local-signer.js";
import { parseChallenge, selectOffer } from "../src/x402.js";

const USDT0 = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const NETWORK = "eip155:196";

const TRANSFER_WITH_AUTHORIZATION_ABI = [
  {
    name: "transferWithAuthorization",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "from" },
      { type: "address", name: "to" },
      { type: "uint256", name: "value" },
      { type: "uint256", name: "validAfter" },
      { type: "uint256", name: "validBefore" },
      { type: "bytes32", name: "nonce" },
      { type: "bytes", name: "signature" }
    ],
    outputs: []
  }
] as const;

async function main() {
  const account = privateKeyToAccount(walletKeyFromEnv());
  const chainId = chainIdFromNetwork(NETWORK);
  const client = createPublicClient({ transport: http(rpcUrlFor(chainId)) });

  // A challenge shaped exactly like the live one from OKLink #2023, but paying
  // ourselves so nothing could move even in principle.
  const challenge = parseChallenge(
    {
      "payment-required": Buffer.from(
        JSON.stringify({
          x402Version: 2,
          resource: { url: "https://example.invalid/verify-signing", mimeType: "application/json" },
          accepts: [
            {
              scheme: "exact",
              network: NETWORK,
              amount: "1",
              payTo: account.address,
              maxTimeoutSeconds: 600,
              asset: USDT0,
              extra: { name: "USD₮0", transferMethod: "eip3009", version: "1", symbol: "USDT" }
            }
          ]
        }),
        "utf8"
      ).toString("base64")
    },
    {}
  );

  const offer = selectOffer(challenge, { allowedAssets: [USDT0], allowedNetworks: [NETWORK] });
  const signed = await localSigner({ nonceSeed: `verify-signing:${Date.now()}` })(challenge, offer);

  const decoded = JSON.parse(Buffer.from(signed.headerValue, "base64").toString("utf8"));
  const auth = decoded.payload.authorization;
  console.log(`signer     : ${signed.wallet}`);
  console.log(`header     : ${signed.headerName}`);
  console.log(`domain     : proven against the token's own DOMAIN_SEPARATOR()`);
  console.log(`nonce      : ${auth.nonce}`);

  const attempt = async (label: string, signature: string) => {
    const data = encodeFunctionData({
      abi: TRANSFER_WITH_AUTHORIZATION_ABI,
      functionName: "transferWithAuthorization",
      args: [
        auth.from as Address,
        auth.to as Address,
        BigInt(auth.value),
        BigInt(auth.validAfter),
        BigInt(auth.validBefore),
        auth.nonce as `0x${string}`,
        signature as `0x${string}`
      ]
    });
    try {
      await client.call({ to: USDT0 as Address, data });
      console.log(`${label}: ACCEPTED by the token`);
      return true;
    } catch (error) {
      const message = String((error as { shortMessage?: string }).shortMessage ?? (error as Error).message);
      console.log(`${label}: reverted -> ${message.split("\n")[0]}`);
      return false;
    }
  };

  const accepted = await attempt("valid signature   ", decoded.payload.signature);

  // Negative control. If a deliberately corrupted signature were also accepted,
  // the check above would have proven nothing.
  const sig: string = decoded.payload.signature;
  const flipped = sig.slice(0, -2) + (sig.slice(-2) === "1b" ? "1c" : "1b");
  const tamperedAccepted = await attempt("tampered signature", flipped);

  if (!accepted || tamperedAccepted) {
    console.error("\nFAILED: signing is not verifiably redeemable.");
    process.exit(1);
  }
  console.log("\nOK: the shipped signing path produces a redeemable authorization.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
