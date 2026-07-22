/**
 * Chain access for in-process signing.
 *
 * Replaces the `onchainos` CLI in the money path. The CLI is a macOS-only
 * binary whose Agentic Wallet login is browser-based, so a container can
 * neither run it nor authenticate it — the deployed procurer could hold a
 * funded key and still be unable to spend a cent. Signing in-process is what
 * makes production capable of the thing the product promises.
 *
 * The delicate part is the EIP-712 domain. An x402 `exact` payment is an
 * EIP-3009 `transferWithAuthorization` signature, and that signature is only
 * redeemable if our domain matches the token's byte for byte. A wrong domain
 * does not error: it produces a well-formed signature that the vendor accepts,
 * relays, and fails to redeem — the money never moves, the call looks paid, and
 * the failure surfaces somewhere unrelated much later.
 *
 * USD₮0 makes that trap concrete. Its `name()` is "USD₮0" using U+20AE (₮), not
 * an ASCII T. `"USDT0"` is the obvious guess, looks identical in most fonts,
 * and is wrong.
 *
 * So nothing here is hardcoded. The domain is read from the token, candidate
 * versions are hashed, and the result is compared against the token's own
 * `DOMAIN_SEPARATOR()`. A domain that does not reproduce it is refused rather
 * than used. That turns "we think the domain is X" into a fact the chain
 * agrees with, checked at runtime on every fresh process.
 */

import { createPublicClient, hashDomain, http, type Address } from "viem";

import { X402Error } from "./x402.js";

export const TOKEN_ABI = [
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "version", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    name: "DOMAIN_SEPARATOR",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }]
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }]
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }]
  }
] as const;

/**
 * `eip155:196` -> 196. Also accepts a bare numeric string.
 *
 * Refuses anything else rather than defaulting. The chain id goes into the
 * signed domain, so a wrong one yields a signature valid on a chain we did not
 * mean to spend on — the one failure mode worth being loud about.
 */
export function chainIdFromNetwork(network: string): number {
  const trimmed = network.trim();
  const caip = /^eip155:(\d+)$/i.exec(trimmed);
  if (caip) return Number(caip[1]);
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  throw new X402Error(
    "UNSUPPORTED_CHALLENGE",
    `cannot derive a chain id from network ${JSON.stringify(network)}; expected eip155:<id>`
  );
}

/**
 * RPC endpoint for a chain.
 *
 * `X402_RPC_URL_<id>` wins so several chains can be configured at once, then
 * the single-chain `X402_RPC_URL`. The X Layer default is the endpoint this
 * repo's on-chain checks were run against; every other chain must be told
 * explicitly rather than guessed.
 */
export function rpcUrlFor(chainId: number): string {
  const specific = process.env[`X402_RPC_URL_${chainId}`];
  if (specific) return specific;
  const generic = process.env.X402_RPC_URL;
  if (generic) return generic;
  if (chainId === 196) return "https://rpc.xlayer.tech";
  throw new X402Error(
    "UNSUPPORTED_CHALLENGE",
    `no RPC endpoint configured for chain ${chainId}; set X402_RPC_URL_${chainId}`
  );
}

const clients = new Map<number, ReturnType<typeof createPublicClient>>();

export function publicClientFor(chainId: number) {
  const existing = clients.get(chainId);
  if (existing) return existing;
  const client = createPublicClient({ transport: http(rpcUrlFor(chainId)) });
  clients.set(chainId, client);
  return client;
}

export type VerifiedDomain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
};

/**
 * Hash a candidate domain the same way EIP-712 does. Pure; exported for tests.
 *
 * The field list is spelled out rather than derived with
 * `getTypesForEIP712Domain`, because VerifiedDomain always carries all four —
 * and a domain whose field set varied would hash differently, which is exactly
 * the class of bug this function exists to catch.
 */
export function domainSeparatorFor(domain: VerifiedDomain): string {
  return hashDomain({
    // uint256 in the type list, so the value must be a bigint for viem's
    // encoder even though the rest of this module works in plain numbers.
    domain: { ...domain, chainId: BigInt(domain.chainId) },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" }
      ]
    }
  });
}

/**
 * Pick the candidate whose hash equals the token's own separator.
 *
 * Pure so the selection logic is testable without a chain. Returns null when
 * nothing matches, which the caller must treat as "refuse to sign" — never as
 * "use the first candidate anyway".
 */
export function matchDomain(candidates: VerifiedDomain[], onchainSeparator: string): VerifiedDomain | null {
  for (const candidate of candidates) {
    if (domainSeparatorFor(candidate).toLowerCase() === onchainSeparator.toLowerCase()) return candidate;
  }
  return null;
}

const domains = new Map<string, VerifiedDomain>();

/**
 * The token's EIP-712 domain, proven against its own DOMAIN_SEPARATOR().
 *
 * A token that does not expose DOMAIN_SEPARATOR() cannot be verified, so it is
 * refused. That is deliberate: the asset allow-list means the set of tokens we
 * pay in is chosen in advance, and "we cannot check this one" is a reason to
 * stop rather than a reason to assume.
 */
export async function verifiedDomain(
  chainId: number,
  token: Address,
  /**
   * What the vendor declared in `accepts[].extra`. x402 sellers advertise the
   * EIP-712 name and version there — OKLink #2023 sends
   * `{name: "USD₮0", version: "1", transferMethod: "eip3009"}` — and that is the
   * protocol's intended way to learn a domain whose name differs from `name()`.
   *
   * Treated as a hint, never as authority: it is attacker-controlled input from
   * the party being paid, so it only ever adds a candidate that must still
   * reproduce the token's own DOMAIN_SEPARATOR to be used.
   */
  hints: { name?: unknown; version?: unknown } = {}
): Promise<VerifiedDomain> {
  const cacheKey = `${chainId}:${token.toLowerCase()}`;
  const cached = domains.get(cacheKey);
  if (cached) return cached;

  const client = publicClientFor(chainId);
  const read = async (functionName: "name" | "version" | "DOMAIN_SEPARATOR") => {
    try {
      return (await client.readContract({ address: token, abi: TOKEN_ABI, functionName })) as string;
    } catch {
      return null;
    }
  };

  const [name, onchainVersion, separator] = await Promise.all([
    read("name"),
    // Optional by EIP-3009; USD₮0 reverts on it, which is normal and not an error.
    read("version"),
    read("DOMAIN_SEPARATOR")
  ]);

  if (!name) {
    throw new X402Error("UNSUPPORTED_CHALLENGE", `token ${token} on chain ${chainId} did not return name()`);
  }
  if (!separator) {
    throw new X402Error(
      "UNSUPPORTED_CHALLENGE",
      `token ${token} on chain ${chainId} does not expose DOMAIN_SEPARATOR(), so its EIP-712 domain ` +
        "cannot be proven. Refusing to sign against an assumed domain."
    );
  }

  // Ordered by confidence: an operator override, what the token says, the
  // vendor's declaration, then the two versions in practical use. Every one is
  // checked against the chain, so a wrong guess is discarded rather than trusted.
  const override = process.env[`X402_TOKEN_VERSION_${chainId}`];
  const hintedVersion = typeof hints.version === "string" ? hints.version : undefined;
  const versions = [override, onchainVersion, hintedVersion, "1", "2"].filter(
    (v): v is string => typeof v === "string" && v !== ""
  );

  // The name is usually name(), but a token whose EIP-712 name differs from its
  // ERC-20 name is exactly the case extra.name exists to cover.
  const hintedName = typeof hints.name === "string" && hints.name !== "" ? hints.name : undefined;
  const names = [...new Set([name, hintedName].filter((n): n is string => typeof n === "string"))];

  const candidates = names.flatMap((candidateName) =>
    [...new Set(versions)].map((version) => ({
      name: candidateName,
      version,
      chainId,
      verifyingContract: token
    }))
  );

  const matched = matchDomain(candidates, separator);
  if (!matched) {
    throw new X402Error(
      "UNSUPPORTED_CHALLENGE",
      `could not reproduce ${token}'s DOMAIN_SEPARATOR() on chain ${chainId} from names ` +
        `${names.map((n) => JSON.stringify(n)).join("|")} and versions ${versions.join("|")}. ` +
        "Refusing to sign a payment that would not be redeemable."
    );
  }

  domains.set(cacheKey, matched);
  return matched;
}

/** Test seam: drop cached clients and domains between cases. */
export function resetChainCaches(): void {
  clients.clear();
  domains.clear();
}
