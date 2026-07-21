import http from "node:http";
import { readFileSync } from "node:fs";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { vetVendor, vetVendors } from "./vet.js";

const servers: http.Server[] = [];

type VendorBehaviour = {
  status?: number;
  amount?: string;
  scheme?: string;
  /** Declared decimals on the accepts entry, when the vendor declares any. */
  decimals?: number;
  body?: unknown;
};

/** A vendor that only ever answers the unpaid probe — vetting never pays. */
async function startVendor(behaviour: VendorBehaviour = {}) {
  const server = http.createServer((req, res) => {
    const status = behaviour.status ?? 402;
    if (status !== 402) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(behaviour.body ?? { error: "not_found" }));
      return;
    }
    const entry: Record<string, unknown> = {
      scheme: behaviour.scheme ?? "exact",
      network: "eip155:196",
      asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      payTo: "0x0000000000000000000000000000000000000402",
      amount: behaviour.amount ?? "15"
    };
    if (behaviour.decimals !== undefined) entry.extra = { decimals: behaviour.decimals };
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ x402Version: 1, accepts: [entry] }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const usdt = (amount: string) => ({ amount, decimals: 6, token: "USDT" });

describe("procurer vetting", () => {
  it("marks a live vendor priced at its listing as hireable", async () => {
    const endpoint = await startVendor({ amount: "15" });
    const result = await vetVendor({
      vendorEndpoint: endpoint,
      tool: "market_snapshot",
      listedAmount: usdt("15"),
      maxAmount: usdt("1000")
    });

    expect(result.verdict).toBe("X402_OK");
    expect(result.hireable).toBe(true);
    expect(result.live_amount?.amount).toBe("15");
    expect(result.price_ratio).toBe(1);
    expect(result.scheme).toBe("exact");
  });

  // The real finding this module exists for: Clawby #3209 lists at 5,000 base
  // units and its live 402 demands 3,000,000. See
  // data/vendor-reliability-2026-07-21.json.
  it("catches a 600x overcharge before any money is committed", async () => {
    const endpoint = await startVendor({ amount: "3000000" });
    const result = await vetVendor({
      vendorEndpoint: endpoint,
      tool: "market_snapshot",
      listedAmount: usdt("5000"),
      maxAmount: usdt("50000")
    });

    // It busts the ceiling too, and the ceiling is what actually binds.
    expect(result.verdict).toBe("OVER_BUDGET");
    expect(result.hireable).toBe(false);
    expect(result.detail).toMatch(/exceeds the ceiling/);
  });

  it("flags a vendor over its listing but keeps it hireable inside the ceiling", async () => {
    const endpoint = await startVendor({ amount: "2000" });
    const result = await vetVendor({
      vendorEndpoint: endpoint,
      tool: "market_snapshot",
      listedAmount: usdt("1000"),
      maxAmount: usdt("10000")
    });

    expect(result.verdict).toBe("PRICE_MISMATCH");
    expect(result.hireable).toBe(true);
    expect(result.price_ratio).toBe(2);
  });

  it("treats a vendor cheaper than its listing as plain X402_OK", async () => {
    // CoinAnk #2013 really does this: listed 10,000, live 1,000.
    const endpoint = await startVendor({ amount: "1000" });
    const result = await vetVendor({
      vendorEndpoint: endpoint,
      tool: "market_snapshot",
      listedAmount: usdt("10000"),
      maxAmount: usdt("20000")
    });

    expect(result.verdict).toBe("X402_OK");
    expect(result.price_ratio).toBe(0.1);
  });

  it("reports a 404 at the listed endpoint as a verdict, not an exception", async () => {
    const endpoint = await startVendor({ status: 404 });
    const result = await vetVendor({
      vendorEndpoint: endpoint,
      tool: "market_snapshot",
      listedAmount: usdt("100")
    });

    expect(result.verdict).toBe("HTTP_ERROR");
    expect(result.hireable).toBe(false);
    expect(result.detail).toMatch(/HTTP 404/);
  });

  it("reports an unreachable vendor as a verdict, not an exception", async () => {
    // Port 1 on loopback: nothing listens, connection refused immediately.
    const result = await vetVendor({ vendorEndpoint: "http://127.0.0.1:1", tool: "market_snapshot" });

    expect(result.verdict).toBe("UNREACHABLE");
    expect(result.hireable).toBe(false);
    expect(result.detail.length).toBeGreaterThan(0);
    expect(result.attempts).toBe(2);
  });

  // SignalForge #6560 behaves exactly like this: one connection failure, then a
  // clean 402. Condemning it on the first probe would have been wrong.
  it("retries a network failure and clears a vendor that was merely cold", async () => {
    let seen = 0;
    const server = http.createServer((req, res) => {
      seen++;
      if (seen === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(402, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:196",
              asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
              payTo: "0x0000000000000000000000000000000000000402",
              amount: "15"
            }
          ]
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const result = await vetVendor(
      { vendorEndpoint: `http://127.0.0.1:${port}`, tool: "t", listedAmount: usdt("15") },
      { attempts: 2 }
    );

    expect(result.verdict).toBe("X402_OK");
    expect(result.attempts).toBe(2);
  });

  // A definitive answer must not be re-asked. Retrying a 404 would triple our
  // traffic against every dead endpoint on the marketplace for no information.
  it("does not retry a definitive HTTP answer", async () => {
    let seen = 0;
    const server = http.createServer((_req, res) => {
      seen++;
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const result = await vetVendor({ vendorEndpoint: `http://127.0.0.1:${port}`, tool: "t" }, { attempts: 3 });

    expect(result.verdict).toBe("HTTP_ERROR");
    expect(seen).toBe(1);
    expect(result.attempts).toBe(1);
  });

  it("treats a vendor that serves without charging as hireable at zero", async () => {
    const endpoint = await startVendor({ status: 200, body: { data: "here you go" } });
    const result = await vetVendor({ vendorEndpoint: endpoint, tool: "market_snapshot" });

    expect(result.verdict).toBe("NO_CHARGE");
    expect(result.hireable).toBe(true);
    expect(result.live_amount?.amount).toBe("0");
  });

  it("rejects an aggr_deferred-only vendor as unsupported", async () => {
    const endpoint = await startVendor({ scheme: "aggr_deferred" });
    const result = await vetVendor({ vendorEndpoint: endpoint, tool: "market_snapshot" });

    expect(result.verdict).toBe("UNSUPPORTED_CHALLENGE");
    expect(result.hireable).toBe(false);
  });

  // The permissive-direction failure: 15 units at 18 decimals is a trillion
  // times 15 units at 6. Vetting must refuse rather than compare.
  it("disqualifies a foreign decimal scale before comparing any price", async () => {
    const endpoint = await startVendor({ amount: "15", decimals: 18 });
    const result = await vetVendor({
      vendorEndpoint: endpoint,
      tool: "market_snapshot",
      listedAmount: usdt("15"),
      maxAmount: usdt("1000")
    });

    expect(result.verdict).toBe("UNSUPPORTED_CHALLENGE");
    expect(result.hireable).toBe(false);
    expect(result.price_ratio).toBe(null);
    expect(result.detail).toMatch(/not comparable across scales/);
  });

  it("keeps batch results aligned to their inputs when a member is dead", async () => {
    const alive = await startVendor({ amount: "15" });
    const results = await vetVendors(
      [
        { vendorEndpoint: alive, tool: "t", listedAmount: usdt("15") },
        { vendorEndpoint: "http://127.0.0.1:1", tool: "t", listedAmount: usdt("15") },
        { vendorEndpoint: alive, tool: "t", listedAmount: usdt("15") }
      ],
      { concurrency: 2 }
    );

    expect(results.map((result) => result.verdict)).toEqual(["X402_OK", "UNREACHABLE", "X402_OK"]);
    expect(results[1].vendor_endpoint).toBe("http://127.0.0.1:1");
  });

  // Structural, not behavioural. Vetting is the one place that talks to vendor
  // endpoints without a cap check in front of it, which is only safe because it
  // cannot sign. If someone imports the signer here that stops being true, and
  // this test is the thing that says so.
  it("cannot sign: the vetting module never imports the signer or a key", () => {
    const source = readFileSync(new URL("./vet.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "\.\/signer\.js"/);
    expect(source).not.toMatch(/FIRM_WALLET_KEY|EVM_PRIVATE_KEY/);
  });
});
