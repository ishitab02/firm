/**
 * Ask OKX's facilitator directly why it rejects a payment, and print the RAW answer.
 *
 *   pnpm -F @firm/gateway probe-facilitator
 *
 * The gateway maps every facilitator refusal onto the generic string
 * "facilitator rejected the payment", which is right for a buyer and useless for
 * debugging. This bypasses the gateway, signs a real challenge with the
 * Agentic Wallet, and posts it to /verify with our own credentials so the
 * unmapped reason is visible.
 *
 * It also A/B tests the `extra` block: the live 402 advertises only
 * `{decimals}`, while OKLink #2023 — a seller whose payments settle — advertises
 * `{name, version, transferMethod, symbol}`. The facilitator has to rebuild the
 * EIP-712 domain to check the signature, and name/version are what that domain
 * is made of.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { okxCredentialsFromEnv, signOkxRequest, splitForSigning } from "../src/okx-auth.js";

const execFileAsync = promisify(execFile);

const GATEWAY = "https://firm-gateway.fly.dev/mcp";
const FACILITATOR = process.env.X402_FACILITATOR_URL ?? "https://web3.okx.com/api/v6/pay/x402";
const CALL = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "express_run",
    arguments: { symbol: "BTC", timeframe: "1h", prompt: "market snapshot" }
  }
};

async function verify(label: string, payload: unknown) {
  const credentials = okxCredentialsFromEnv();
  if (!credentials) throw new Error("OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE not set");
  const url = `${FACILITATOR.replace(/\/$/, "")}/verify`;
  const { requestPath } = splitForSigning(url);
  const body = JSON.stringify(payload);
  const response = await fetch(url, {
    method: "POST",
    headers: signOkxRequest(credentials, { method: "POST", requestPath, body }),
    body
  });
  const text = await response.text();
  const ok = !text.includes("30001") && !text.includes("incorrect params");
  console.log(`\n${ok ? "*** " : ""}${label}`);
  console.log(`  HTTP ${response.status}`);
  console.log(`  ${text.slice(0, 600)}`);
}

async function main() {
  // 1. real challenge from the live gateway
  const challengeResponse = await fetch(GATEWAY, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(CALL)
  });
  const challenge = challengeResponse.headers.get("payment-required");
  if (!challenge) throw new Error(`expected a 402 challenge, got HTTP ${challengeResponse.status}`);
  const decoded = JSON.parse(Buffer.from(challenge, "base64").toString("utf8"));
  const accepts0 = decoded.accepts[0];
  console.log(`challenge extra: ${JSON.stringify(accepts0.extra)}`);

  // 2. sign it with the Agentic Wallet
  const { stdout } = await execFileAsync("onchainos", ["payment", "pay", "--payload", challenge], {
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024
  });
  const parsed = JSON.parse(stdout);
  const proof = parsed.data ?? parsed;
  if (!proof.signature || !proof.authorization) throw new Error(`no proof: ${stdout.slice(0, 300)}`);
  console.log(`signed by ${proof.authorization.from}`);

  // The decoded payload object, and the same thing base64'd as a header string.
  const payloadObject = {
    x402Version: 2,
    scheme: accepts0.scheme,
    network: accepts0.network,
    accepted: accepts0,
    payload: { authorization: proof.authorization, signature: proof.signature }
  };
  const headerString = Buffer.from(JSON.stringify(payloadObject), "utf8").toString("base64");

  // What the gateway sends today.
  await verify("A) {paymentHeader, paymentRequirements}  <- current gateway", {
    paymentHeader: headerString,
    paymentRequirements: accepts0
  });

  // The x402 facilitator spec shape: a decoded payload plus an explicit version.
  await verify("B) {x402Version, paymentPayload, paymentRequirements}", {
    x402Version: 2,
    paymentPayload: payloadObject,
    paymentRequirements: accepts0
  });

  await verify("C) {paymentPayload, paymentRequirements} (no version)", {
    paymentPayload: payloadObject,
    paymentRequirements: accepts0
  });

  // Some implementations take the header string under the payload key.
  await verify("D) {x402Version, paymentPayload: <base64>, paymentRequirements}", {
    x402Version: 2,
    paymentPayload: headerString,
    paymentRequirements: accepts0
  });

  // snake_case variant.
  await verify("E) {x402_version, payment_payload, payment_requirements}", {
    x402_version: 2,
    payment_payload: payloadObject,
    payment_requirements: accepts0
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
