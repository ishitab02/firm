#!/usr/bin/env node
import http from "node:http";
import {
  buildDeliverable,
  legacyX402Challenge,
  serviceFor,
  standardX402Challenge,
  validateDeliverable,
  vendors
} from "./fixtures.js";

const vendorKey = process.argv[2] ?? "vendor_good";
const vendor = vendors[vendorKey];

if (!vendor) {
  console.error(`Unknown vendor "${vendorKey}". Expected one of: ${Object.keys(vendors).join(", ")}`);
  process.exit(1);
}

const port = Number(process.env.PORT ?? vendor.default_port);
let paidCallCount = 0;

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    ...headers
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleTool(req, res, tool) {
  const service = serviceFor(vendor, tool);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const challengeShape = url.searchParams.get("challenge") ?? "standard";
  const paymentHeader = req.headers["x-payment"];

  if (!paymentHeader) {
    const challenge =
      challengeShape === "legacy"
        ? legacyX402Challenge(vendor, service)
        : standardX402Challenge(vendor, service);
    sendJson(res, 402, challenge);
    return;
  }

  const args = await readJson(req);

  if (vendorKey === "vendor_dead") {
    setTimeout(() => {
      sendJson(res, 504, { error: { code: "VENDOR_TIMEOUT", detail: "mock timeout elapsed" } });
    }, Math.min(vendor.latency_ms, 70000));
    return;
  }

  paidCallCount += 1;
  const result = buildDeliverable(vendorKey, tool, args, paidCallCount);
  const validation = validateDeliverable(result);

  setTimeout(() => {
    sendJson(res, 200, {
      vendor: {
        agent_id: vendor.agent_id,
        name: vendor.name
      },
      result,
      validation_hint: validation,
      receipt_hint: {
        amount: service.price,
        tx: `SIMULATED:${vendor.agent_id}:${paidCallCount}`,
        payment_response: "SIMULATED mock x402 payment accepted"
      }
    });
  }, vendor.latency_ms);
}

async function handleMcp(req, res) {
  const body = await readJson(req);
  const method = body.method;
  const params = body.params ?? {};

  if (method === "tools/list") {
    sendJson(res, 200, {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        tools: vendor.services.map((service) => ({
          name: service.tool,
          description: `${vendor.name} mock ${service.capability}`,
          inputSchema: { type: "object", additionalProperties: true }
        }))
      }
    });
    return;
  }

  if (method === "tools/call") {
    const tool = params.name;
    const service = serviceFor(vendor, tool);
    paidCallCount += 1;
    const result = buildDeliverable(vendorKey, tool, params.arguments ?? {}, paidCallCount);
    sendJson(res, 200, {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [{ type: "json", json: result }],
        structuredContent: {
          result,
          receipt_hint: {
            amount: service.price,
            tx: `SIMULATED:${vendor.agent_id}:${paidCallCount}`
          }
        }
      }
    });
    return;
  }

  sendJson(res, 404, {
    jsonrpc: "2.0",
    id: body.id,
    error: { code: -32601, message: `Unknown method ${method}` }
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        vendor: {
          agent_id: vendor.agent_id,
          name: vendor.name,
          personality: vendor.personality
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/mcp") {
      await handleMcp(req, res);
      return;
    }

    const toolMatch = url.pathname.match(/^\/tools\/([^/]+)$/);
    if (req.method === "POST" && toolMatch) {
      await handleTool(req, res, toolMatch[1]);
      return;
    }

    sendJson(res, 404, { error: { code: "NOT_FOUND" } });
  } catch (error) {
    sendJson(res, 500, {
      error: {
        code: "MOCK_VENDOR_ERROR",
        detail: error instanceof Error ? error.message : String(error)
      }
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`${vendorKey} listening on http://127.0.0.1:${port}`);
});
