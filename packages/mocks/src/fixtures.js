export const USDT_DECIMALS = 6;

export function usdt(units) {
  return { amount: String(units), decimals: USDT_DECIMALS, token: "USDT" };
}

export const vendors = {
  vendor_good: {
    agent_id: "mock-good-001",
    name: "Firm Mock Reliable Vendor",
    personality: "reliable",
    default_port: 4311,
    latency_ms: 180,
    kya_base_score: 86,
    flags: [],
    services: [
      {
        tool: "market_snapshot",
        capability: "market_snapshot",
        price: usdt(100000)
      },
      {
        tool: "launch_brief",
        capability: "token_launch",
        price: usdt(350000)
      }
    ]
  },
  vendor_flaky: {
    agent_id: "mock-flaky-001",
    name: "Firm Mock Flaky Vendor",
    personality: "schema_staleness_failure",
    default_port: 4312,
    latency_ms: 240,
    kya_base_score: 72,
    flags: [],
    services: [
      {
        tool: "market_snapshot",
        capability: "market_snapshot",
        price: usdt(90000)
      },
      {
        tool: "launch_brief",
        capability: "token_launch",
        price: usdt(300000)
      }
    ]
  },
  vendor_dead: {
    agent_id: "mock-dead-001",
    name: "Firm Mock Dead Vendor",
    personality: "timeout",
    default_port: 4313,
    latency_ms: 70000,
    kya_base_score: 64,
    flags: [],
    services: [
      {
        tool: "market_snapshot",
        capability: "market_snapshot",
        price: usdt(80000)
      },
      {
        tool: "launch_brief",
        capability: "token_launch",
        price: usdt(250000)
      }
    ]
  },
  vendor_rejected: {
    agent_id: "mock-rejected-001",
    name: "Firm Mock Low Trust Vendor",
    personality: "low_trust",
    default_port: 4314,
    latency_ms: 160,
    kya_base_score: 41,
    flags: ["BURST_FEEDBACK"],
    services: [
      {
        tool: "launch_brief",
        capability: "token_launch",
        price: usdt(200000)
      }
    ]
  }
};

export function vendorIndex(baseUrl = "http://127.0.0.1") {
  return Object.values(vendors).map((vendor) => ({
    agent_id: vendor.agent_id,
    name: vendor.name,
    endpoint: `${baseUrl}:${vendor.default_port}`,
    services: vendor.services,
    kya_base_score: vendor.kya_base_score,
    flags: vendor.flags,
    last_verified_at: "2026-07-18T00:00:00Z"
  }));
}

export function standardX402Challenge(vendor, service) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "xlayer",
        maxAmountRequired: service.price.amount,
        resource: `${vendor.agent_id}:${service.tool}`,
        description: `${vendor.name} ${service.tool}`,
        mimeType: "application/json",
        payTo: "0x0000000000000000000000000000000000000402",
        maxTimeoutSeconds: 60,
        asset: service.price.token,
        outputSchema: {
          input: { type: "object" },
          output: { type: "object" }
        },
        extra: { decimals: service.price.decimals }
      }
    ],
    error: "x402 payment required"
  };
}

export function legacyX402Challenge(vendor, service) {
  return {
    error: {
      code: "PAYMENT_REQUIRED",
      message: "x402 payment required",
      payment: {
        amount: service.price,
        recipient: "0x0000000000000000000000000000000000000402",
        network: "xlayer",
        service: `${vendor.agent_id}:${service.tool}`
      }
    }
  };
}

export function serviceFor(vendor, tool) {
  const service = vendor.services.find((candidate) => candidate.tool === tool);
  if (!service) {
    throw new Error(`Unknown mock tool ${tool} for ${vendor.agent_id}`);
  }
  return service;
}

export function buildDeliverable(vendorKey, tool, args = {}, paidCallCount = 1) {
  const now = "2026-07-18T12:00:00Z";

  if (vendorKey === "vendor_dead") {
    return { timeout: true };
  }

  if (vendorKey === "vendor_flaky") {
    const failureMode = args.failure_mode ?? (paidCallCount >= 1 ? "stale_schema" : "none");
    if (failureMode === "stale_schema") {
      return {
        headline: "Market snapshot unavailable",
        // Missing required observations array, intentionally.
        generated_at: "2026-07-10T12:00:00Z",
        source_urls: ["https://example.invalid/stale"]
      };
    }
  }

  if (tool === "market_snapshot") {
    return {
      kind: "market_snapshot",
      subject: args.subject ?? "BTC",
      observations: [
        "Spot liquidity is concentrated in the top venues.",
        "Recent volatility requires fresh risk checks before execution."
      ],
      generated_at: now,
      source_urls: ["https://example.com/mock-market-snapshot"]
    };
  }

  return {
    kind: "launch_brief",
    project: args.project ?? "demo token",
    checklist: [
      "Confirm chain and token standard.",
      "Publish launch messaging.",
      "Prepare liquidity and monitoring steps."
    ],
    generated_at: now,
    source_urls: ["https://example.com/mock-launch-brief"]
  };
}

export function validateDeliverable(deliverable, { now = "2026-07-18T12:30:00Z" } = {}) {
  const checksRun = ["schema", "non_empty_content", "freshness"];
  const failures = [];

  if (!deliverable || typeof deliverable !== "object") {
    failures.push({ check: "schema", detail: "deliverable is not an object" });
  }

  if (!Array.isArray(deliverable.observations) && !Array.isArray(deliverable.checklist)) {
    failures.push({
      check: "schema",
      detail: "deliverable must include observations or checklist array"
    });
  }

  const content = deliverable?.observations ?? deliverable?.checklist ?? [];
  if (!Array.isArray(content) || content.length === 0) {
    failures.push({ check: "non_empty_content", detail: "deliverable content is empty" });
  }

  if (!deliverable?.generated_at) {
    failures.push({ check: "freshness", detail: "generated_at is missing" });
  } else {
    const ageMs = Date.parse(now) - Date.parse(deliverable.generated_at);
    if (!Number.isFinite(ageMs) || ageMs > 60 * 60 * 1000) {
      failures.push({ check: "freshness", detail: "generated_at is older than one hour" });
    }
  }

  return {
    passed: failures.length === 0,
    checks_run: checksRun,
    failures
  };
}
