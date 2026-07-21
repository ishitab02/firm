import http from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { payAndCallVendor, toolUrl } from "./vendor.js";
import { Signer } from "./signer.js";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

const accepts = (amount: string) => [
  {
    scheme: "exact",
    network: "eip155:196",
    asset: "0xAAAA",
    payTo: "0x0000000000000000000000000000000000000402",
    amount
  }
];

type ServerBehaviour = {
  challengeAmount?: string;
  challengeIn?: "header" | "body";
  paidStatus?: number;
  paidBody?: unknown;
  settlement?: unknown;
  probeStatus?: number;
};

const servers: http.Server[] = [];

/** A vendor that answers 402 until it sees a payment header. */
async function startVendor(behaviour: ServerBehaviour = {}) {
  const seen: Array<{ headers: http.IncomingHttpHeaders; url?: string }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ headers: req.headers, url: req.url });
    const paid = req.headers["payment-signature"] ?? req.headers["x-payment"];

    if (behaviour.probeStatus && !paid) {
      res.writeHead(behaviour.probeStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "vendor said no" }));
      return;
    }

    if (!paid) {
      const payload = { x402Version: 2, accepts: accepts(behaviour.challengeAmount ?? "100000") };
      if ((behaviour.challengeIn ?? "header") === "header") {
        res.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": b64(payload) });
        res.end(JSON.stringify({ error: "payment required" }));
      } else {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...payload, x402Version: 1 }));
      }
      return;
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (behaviour.settlement !== null) {
      headers["PAYMENT-RESPONSE"] = b64(
        behaviour.settlement ?? { status: "success", transaction: "0xdeadbeef", payer: "0xfirm" }
      );
    }
    res.writeHead(behaviour.paidStatus ?? 200, headers);
    res.end(JSON.stringify(behaviour.paidBody ?? { kind: "market_snapshot", observations: ["ok"] }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${port}`, seen };
}

/** Stands in for `onchainos payment pay-local`. Never touches a key. */
const fakeSigner = (log?: string[]): Signer => async (_challenge, offer) => {
  log?.push(`sign:${offer.amountUnits}`);
  return { headerName: "PAYMENT-SIGNATURE", headerValue: "signed-payload", scheme: offer.scheme };
};

const baseOptions = { decimals: 6, token: "USDT", timeoutMs: 5_000 };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("payAndCallVendor", () => {
  it("probes, pays, replays, and records the settlement transaction", async () => {
    const { endpoint, seen } = await startVendor({ challengeAmount: "100000" });

    const outcome = await payAndCallVendor(
      { vendorEndpoint: endpoint, tool: "market_snapshot", args: { subject: "BTC" } },
      { ...baseOptions, signer: fakeSigner(), verifyCaps: async () => null }
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.receipt.tx).toBe("0xdeadbeef");
    expect(outcome.receipt.amount).toEqual({ amount: "100000", decimals: 6, token: "USDT" });
    expect(outcome.receipt.pay_to).toBe("0x0000000000000000000000000000000000000402");
    // Exactly two round trips: the unpaid probe and the paid replay.
    expect(seen).toHaveLength(2);
    expect(seen[0].headers["payment-signature"]).toBeUndefined();
    expect(seen[1].headers["payment-signature"]).toBe("signed-payload");
    expect(seen[1].url).toBe("/tools/market_snapshot");
  });

  it("verifies caps BEFORE the signer runs and never signs on rejection", async () => {
    const order: string[] = [];
    const { endpoint, seen } = await startVendor({ challengeAmount: "100000" });

    const outcome = await payAndCallVendor(
      { vendorEndpoint: endpoint, tool: "market_snapshot", args: {} },
      {
        ...baseOptions,
        signer: fakeSigner(order),
        verifyCaps: async (offer) => {
          order.push(`verify:${offer.amountUnits}`);
          return { detail: "per-call cap would be exceeded before payment" };
        }
      }
    );

    expect(outcome).toMatchObject({ ok: false, error_code: "CAP_EXCEEDED" });
    expect(order).toEqual(["verify:100000"]);
    // Only the unpaid probe went out. Nothing was signed, nothing was replayed.
    expect(seen).toHaveLength(1);
  });

  it("passes the vendor's actual price to the cap check, not the caller's ceiling", async () => {
    const seenAmounts: number[] = [];
    const { endpoint } = await startVendor({ challengeAmount: "42" });

    await payAndCallVendor(
      { vendorEndpoint: endpoint, tool: "market_snapshot", args: {} },
      {
        ...baseOptions,
        signer: fakeSigner(),
        verifyCaps: async (offer) => {
          seenAmounts.push(offer.amountUnits);
          return null;
        }
      }
    );

    expect(seenAmounts).toEqual([42]);
  });

  it("fires onSigned exactly once, after signing and before the replay", async () => {
    const order: string[] = [];
    const { endpoint } = await startVendor();

    await payAndCallVendor(
      { vendorEndpoint: endpoint, tool: "market_snapshot", args: {} },
      {
        ...baseOptions,
        signer: fakeSigner(order),
        verifyCaps: async () => null,
        onSigned: async () => {
          order.push("onSigned");
        }
      }
    );

    expect(order).toEqual(["sign:100000", "onSigned"]);
  });

  it("handles a v1 body-carried challenge", async () => {
    const { endpoint } = await startVendor({ challengeIn: "body", challengeAmount: "90000" });

    const outcome = await payAndCallVendor(
      { vendorEndpoint: endpoint, tool: "market_snapshot", args: {} },
      { ...baseOptions, signer: fakeSigner(), verifyCaps: async () => null }
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.receipt.amount.amount).toBe("90000");
  });

  it("reports a re-issued 402 as a payment failure rather than retrying", async () => {
    const { endpoint } = await startVendor({ paidStatus: 402 });

    const outcome = await payAndCallVendor(
      { vendorEndpoint: endpoint, tool: "market_snapshot", args: {} },
      { ...baseOptions, signer: fakeSigner(), verifyCaps: async () => null }
    );

    expect(outcome).toMatchObject({ ok: false, error_code: "PAYMENT_FAILED" });
  });

  it("says so instead of inventing a hash when settlement is still pending", async () => {
    const { endpoint } = await startVendor({ settlement: { status: "pending" } });

    const outcome = await payAndCallVendor(
      { vendorEndpoint: endpoint, tool: "market_snapshot", args: {} },
      { ...baseOptions, signer: fakeSigner(), verifyCaps: async () => null }
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.receipt.tx).toBe("PENDING_SETTLEMENT:exact");
  });

  it("treats a vendor that serves without charging as a free call, not an error", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ kind: "market_snapshot" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const outcome = await payAndCallVendor(
      { vendorEndpoint: `http://127.0.0.1:${port}`, tool: "market_snapshot", args: {} },
      { ...baseOptions, signer: fakeSigner(), verifyCaps: async () => null }
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.receipt.amount.amount).toBe("0");
  });

  it("surfaces a non-402 vendor error without paying", async () => {
    const { endpoint } = await startVendor({ probeStatus: 500 });

    const outcome = await payAndCallVendor(
      { vendorEndpoint: endpoint, tool: "market_snapshot", args: {} },
      { ...baseOptions, signer: fakeSigner(), verifyCaps: async () => null }
    );

    expect(outcome).toMatchObject({ ok: false, error_code: "VENDOR_ERROR" });
  });

  it("reports an unreachable vendor as a timeout", async () => {
    const outcome = await payAndCallVendor(
      // Port 1 is reserved and refuses connections.
      { vendorEndpoint: "http://127.0.0.1:1", tool: "market_snapshot", args: {} },
      { ...baseOptions, signer: fakeSigner(), verifyCaps: async () => null }
    );

    expect(outcome).toMatchObject({ ok: false, error_code: "VENDOR_TIMEOUT" });
  });
});

describe("toolUrl", () => {
  it("appends the tool path to a bare endpoint", () => {
    expect(toolUrl("http://127.0.0.1:4311", "market_snapshot")).toBe("http://127.0.0.1:4311/tools/market_snapshot");
  });

  it("leaves an endpoint that already carries a path alone", () => {
    expect(toolUrl("https://vendor.example/mcp", "market_snapshot")).toBe("https://vendor.example/mcp");
  });
});

describe("decimal-scale safety", () => {
  it("refuses to pay when the vendor prices in different decimals than max_amount", async () => {
    const order: string[] = [];
    // 15 units at 18 decimals is a trillion times 15 units at 6 decimals. If
    // the scales were compared as raw integers this would sail past the caps.
    const server = http.createServer((req, res) => {
      const payload = {
        x402Version: 2,
        accepts: [{ ...accepts("15")[0], extra: { decimals: 18 } }]
      };
      res.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": b64(payload) });
      res.end(JSON.stringify({ error: "payment required" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const outcome = await payAndCallVendor(
      { vendorEndpoint: `http://127.0.0.1:${port}`, tool: "market_snapshot", args: {} },
      {
        ...baseOptions,
        decimals: 6,
        signer: fakeSigner(order),
        verifyCaps: async () => {
          order.push("verify");
          return null;
        }
      }
    );

    expect(outcome).toMatchObject({ ok: false, error_code: "UNSUPPORTED_CHALLENGE" });
    // Rejected before the caps were even consulted, and nothing was signed.
    expect(order).toEqual([]);
  });

  it("proceeds when the vendor's declared decimals match", async () => {
    const server = http.createServer((req, res) => {
      const paid = req.headers["payment-signature"];
      if (!paid) {
        const payload = { x402Version: 2, accepts: [{ ...accepts("15")[0], extra: { decimals: 6 } }] };
        res.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": b64(payload) });
        res.end("{}");
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "PAYMENT-RESPONSE": b64({ status: "success", transaction: "0xok" })
      });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const outcome = await payAndCallVendor(
      { vendorEndpoint: `http://127.0.0.1:${port}`, tool: "market_snapshot", args: {} },
      { ...baseOptions, decimals: 6, signer: fakeSigner(), verifyCaps: async () => null }
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.receipt.declared_decimals).toBe(6);
  });

  it("records null decimals when the vendor never declared a scale", async () => {
    const { endpoint } = await startVendor({ challengeAmount: "100000" });
    const outcome = await payAndCallVendor(
      { vendorEndpoint: endpoint, tool: "market_snapshot", args: {} },
      { ...baseOptions, signer: fakeSigner(), verifyCaps: async () => null }
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.receipt.declared_decimals).toBeNull();
  });
});
