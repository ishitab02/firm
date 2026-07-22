/**
 * Diff the header this repo produces against the one the OKX CLI produces, for
 * the same live challenge.
 *
 *   pnpm -F @firm/procurer diff-signers
 *
 * G3 failed with "vendor rejected the signed payment and re-issued a 402" while
 * the token itself accepts our signature (scripts/verify-signing.ts). That
 * narrows the fault to the header we send, not the cryptography — and the CLI's
 * header shape is known-good because it is what G1 and G2 paid with.
 *
 * Signing costs nothing and moves nothing; both paths only produce bytes.
 * Requires the macOS CLI, so this is a diagnostic to run locally, never in CI.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { localSigner } from "../src/local-signer.js";
import { parseChallenge, payloadForOffer, selectOffer } from "../src/x402.js";

const execFileAsync = promisify(execFile);

const ENDPOINT = "https://www.oklink.com/api/v5/explorer/mcp/x402/get_address_balance_history";
const ARGS = { chainIndex: "1", address: "0x0000000000000000000000000000000000000000", height: "21000000" };

function decode(headerValue: string): unknown {
  return JSON.parse(Buffer.from(headerValue.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8"));
}

async function main() {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ARGS)
  });
  console.log(`vendor status: ${response.status}`);
  if (response.status !== 402) {
    console.log("expected a 402 challenge; got:", (await response.text()).slice(0, 400));
    process.exit(1);
  }

  const headers: Record<string, string | undefined> = {};
  response.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
  let body: unknown = {};
  try {
    body = await response.json();
  } catch {
    /* v2 carries the challenge in a header, so an unparseable body is fine */
  }

  const challenge = parseChallenge(headers, body);
  const offer = selectOffer(challenge, {
    allowedAssets: ["0x779ded0c9e1022225f8e0630b35a9b54be713736"],
    allowedNetworks: ["eip155:196"]
  });
  console.log(`challenge version: ${challenge.version}`);
  console.log(`offer: ${offer.scheme} ${offer.amountUnits} @ ${offer.network} -> ${offer.payTo}`);
  console.log(`accepts[].extra: ${JSON.stringify(offer.entry.extra)}\n`);

  // --- ours ---
  const ours = await localSigner({ nonceSeed: `diff-signers:${Date.now()}` })(challenge, offer);
  console.log(`OURS  header name : ${ours.headerName}`);
  console.log(`OURS  body        : ${JSON.stringify(decode(ours.headerValue), null, 2)}\n`);

  // --- the CLI's ---
  const key = process.env.FIRM_WALLET_KEY;
  if (!key) {
    console.log("FIRM_WALLET_KEY unset; skipping the CLI comparison.");
    return;
  }
  try {
    const { stdout } = await execFileAsync(
      process.env.OKX_CLI_BIN ?? "onchainos",
      ["payment", "pay-local", "--payload", payloadForOffer(challenge, offer)],
      { env: { ...process.env, EVM_PRIVATE_KEY: key }, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const data = (typeof parsed.data === "object" && parsed.data !== null ? parsed.data : parsed) as Record<
      string,
      unknown
    >;
    console.log(`CLI   raw output keys : ${Object.keys(data).join(", ")}`);
    console.log(`CLI   header name     : ${data.header_name ?? "(none)"}`);
    const headerValue = data.authorization_header;
    if (typeof headerValue === "string") {
      console.log(`CLI   body            : ${JSON.stringify(decode(headerValue), null, 2)}`);
    } else {
      console.log(`CLI   full output     : ${JSON.stringify(data, null, 2)}`);
    }
  } catch (error) {
    console.log("CLI failed:", error instanceof Error ? error.message.split("\n")[0] : String(error));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
