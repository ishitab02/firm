/**
 * MCP protocol surface for the gateway.
 *
 * This is the discovery/handshake layer OKX review probes. Treasury's listing
 * was rejected for an unreachable endpoint that never returned a proper MCP
 * response or 402; the gateway must answer `initialize` and `tools/list`
 * without payment, then route `tools/call` to the charge gate.
 *
 * Pure and side-effect free so it can be unit-tested without starting the
 * server (server.ts has a top-level listen()).
 */

/** The MCP protocol version this server speaks; echoed back if the client asks for one. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * The five tools from INTERFACES §1, advertised over MCP `tools/list`.
 */
export const TOOL_DEFINITIONS = [
  {
    name: "get_quote",
    description: "Free. Quote a fixed price to deliver a goal within a budget and constraints.",
    inputSchema: {
      type: "object",
      required: ["goal", "budget_cap"],
      properties: {
        goal: { type: "string" },
        budget_cap: {
          type: "object",
          required: ["amount", "decimals"],
          properties: { amount: { type: "string" }, decimals: { type: "number" }, token: { type: "string" } }
        },
        constraints: {
          type: "object",
          properties: {
            deadline_minutes: { type: "number" },
            min_vendor_score: { type: "number" },
            banned_categories: { type: "array", items: { type: "string" } }
          }
        }
      }
    }
  },
  {
    name: "execute",
    description: "Paid at the quoted price. Start a job from a quote and return its task_id.",
    inputSchema: { type: "object", required: ["quote_id"], properties: { quote_id: { type: "string" } } }
  },
  {
    name: "get_status",
    description: "Free. Return the current state and per-subtask progress of a task.",
    inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "string" } } }
  },
  {
    name: "get_result",
    description: "Free. Return the deliverable and provenance receipt of a completed task.",
    inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "string" } } }
  },
  {
    name: "express_run",
    description:
      "Paid, fixed price. Exact crypto market snapshot from public candles; validates symbol, timeframe, price action, trend, support and resistance before settlement.",
    inputSchema: {
      type: "object",
      required: ["job_type", "params"],
      properties: {
        job_type: { type: "string", enum: ["market_snapshot"] },
        params: {
          type: "object",
          required: ["symbol", "timeframe", "prompt"],
          properties: {
            symbol: { type: "string" },
            timeframe: { type: "string" },
            prompt: { type: "string" }
          }
        }
      }
    }
  }
];

export type McpDispatch =
  | { kind: "protocol"; result: unknown }
  | { kind: "notification" }
  | { kind: "error"; code: number; message: string }
  | { kind: "tool"; name: string; args: any };

/**
 * Route a request body to either an MCP protocol response or a tool call.
 *
 * Protocol methods (initialize, tools/list, ping, notifications/*) are free and
 * key-free discovery — they must answer before any payment. Only `tools/call`
 * and the legacy `{tool, args}` REST shape reach the charge gate.
 */
export function mcpDispatch(body: any): McpDispatch {
  // Legacy REST shape kept for the eval harness and demo: { tool, args }.
  if (typeof body?.method !== "string") {
    return { kind: "tool", name: body?.tool, args: body?.args ?? {} };
  }

  switch (body.method) {
    case "initialize":
      return {
        kind: "protocol",
        result: {
          protocolVersion: body.params?.protocolVersion ?? MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "firm-gateway", version: "0.1.0" }
        }
      };
    case "tools/list":
      return { kind: "protocol", result: { tools: TOOL_DEFINITIONS } };
    case "ping":
      return { kind: "protocol", result: {} };
    case "tools/call":
      return { kind: "tool", name: body.params?.name, args: body.params?.arguments ?? {} };
    default:
      // JSON-RPC notifications have no id and expect no response body.
      if (body.method.startsWith("notifications/") || body.id === undefined) return { kind: "notification" };
      return { kind: "error", code: -32601, message: `method not found: ${body.method}` };
  }
}
