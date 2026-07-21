import { describe, expect, it } from "vitest";

import { mcpDispatch, TOOL_DEFINITIONS } from "./mcp.js";

describe("mcpDispatch", () => {
  it("answers initialize with serverInfo and echoes the client's protocol version", () => {
    const d = mcpDispatch({ method: "initialize", id: 1, params: { protocolVersion: "2024-11-05" } });
    expect(d.kind).toBe("protocol");
    if (d.kind !== "protocol") return;
    const result = d.result as any;
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.serverInfo.name).toBe("firm-gateway");
    expect(result.capabilities.tools).toBeDefined();
  });

  it("lists exactly the five INTERFACES tools", () => {
    const d = mcpDispatch({ method: "tools/list", id: 2 });
    expect(d.kind).toBe("protocol");
    if (d.kind !== "protocol") return;
    const names = (d.result as any).tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["execute", "express_run", "get_quote", "get_result", "get_status"]);
    // Every advertised tool carries an input schema the client can validate against.
    for (const tool of TOOL_DEFINITIONS) expect(tool.inputSchema.type).toBe("object");
  });

  it("routes tools/call to the named tool with its arguments", () => {
    const d = mcpDispatch({ method: "tools/call", id: 3, params: { name: "execute", arguments: { quote_id: "q_1" } } });
    expect(d).toEqual({ kind: "tool", name: "execute", args: { quote_id: "q_1" } });
  });

  it("keeps supporting the legacy REST shape", () => {
    const d = mcpDispatch({ tool: "get_status", args: { task_id: "t_1" } });
    expect(d).toEqual({ kind: "tool", name: "get_status", args: { task_id: "t_1" } });
  });

  it("treats notifications/* as fire-and-forget", () => {
    expect(mcpDispatch({ method: "notifications/initialized" })).toEqual({ kind: "notification" });
  });

  it("answers ping with an empty result", () => {
    expect(mcpDispatch({ method: "ping", id: 4 })).toEqual({ kind: "protocol", result: {} });
  });

  it("returns method-not-found for an unknown method with an id", () => {
    const d = mcpDispatch({ method: "resources/list", id: 5 });
    expect(d).toMatchObject({ kind: "error", code: -32601 });
  });
});
