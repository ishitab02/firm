import { describe, expect, it } from "vitest";

import {
  coerceProjectArgs,
  directHttpToolCall,
  PROJECT_EXECUTE_HTTP_INPUT,
  projectSpecFromGoal
} from "./project-args.js";

/**
 * The OKX payment CLI sends `--param key=value` as flat strings, so a buyer's
 * `--param budget_cap={...}` reaches the server as a JSON *string*. These pin
 * that it is coerced back to an object — a direct JSON POST already sends the
 * object, so the two entry paths must agree.
 */
describe("coerceProjectArgs — CLI flat-string params become objects", () => {
  it("parses a stringified budget_cap, the exact shape onchainos --param sends", () => {
    const coerced = coerceProjectArgs({
      goal: "BTC and ETH on 1h and 4h",
      budget_cap: '{"amount":"1000000","decimals":6,"token":"USDT"}'
    }) as Record<string, unknown>;
    expect(coerced.budget_cap).toEqual({ amount: "1000000", decimals: 6, token: "USDT" });
  });

  it("leaves an already-object budget_cap untouched (direct JSON POST path)", () => {
    const object = { amount: "1000000", decimals: 6, token: "USDT" };
    const coerced = coerceProjectArgs({ goal: "g", budget_cap: object }) as Record<string, unknown>;
    expect(coerced.budget_cap).toEqual(object);
  });

  it("coerces constraints the same way", () => {
    const coerced = coerceProjectArgs({
      goal: "g",
      budget_cap: '{"amount":"1000000","decimals":6}',
      constraints: '{"min_vendor_score":80}'
    }) as Record<string, unknown>;
    expect(coerced.constraints).toEqual({ min_vendor_score: 80 });
  });

  it("leaves a non-JSON string in place so the schema still rejects it", () => {
    const coerced = coerceProjectArgs({ goal: "g", budget_cap: "one dollar" }) as Record<string, unknown>;
    expect(coerced.budget_cap).toBe("one dollar");
  });

  it("does not turn a JSON array or scalar string into an object", () => {
    const coerced = coerceProjectArgs({ goal: "g", budget_cap: "[1,2,3]" }) as Record<string, unknown>;
    expect(coerced.budget_cap).toBe("[1,2,3]");
  });

  it("passes non-object args through unchanged", () => {
    expect(coerceProjectArgs(null)).toBe(null);
    expect(coerceProjectArgs("x")).toBe("x");
  });
});

describe("Projects v1 contract", () => {
  it("plans one timeframe across two assets as two paid-and-validated legs", () => {
    const parsed = projectSpecFromGoal(
      "Compare BTC and ETH on 4h: price action, trend, support and resistance"
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.spec.requests.map(({ symbol, timeframe }) => [symbol, timeframe])).toEqual([
      ["BTC", "4h"],
      ["ETH", "4h"]
    ]);
    expect(parsed.spec.plan.map((item) => item.subtask)).toEqual([
      "BTC 4h market snapshot",
      "ETH 4h market snapshot"
    ]);
  });

  it("plans one asset across two timeframes", () => {
    const parsed = projectSpecFromGoal("Analyse ETH on 1h and 4h with market trend and support/resistance");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.spec.requests.map(({ symbol, timeframe }) => [symbol, timeframe])).toEqual([
      ["ETH", "1h"],
      ["ETH", "4h"]
    ]);
  });

  it("refuses single-leg work because that is the cheaper Express contract", () => {
    const parsed = projectSpecFromGoal("ETH 4h market snapshot with trend and support");
    expect(parsed).toMatchObject({ ok: false, detail: expect.stringContaining("use Express") });
  });

  it("refuses unsupported generic or launch work before payment", () => {
    expect(projectSpecFromGoal("launch a token")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("BTC and/or ETH")
    });
  });

  it("bounds the cross-product so a fixed-price project cannot grow without limit", () => {
    expect(projectSpecFromGoal("Compare BTC and ETH on 1h 2h 4h 1d market trend")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("at most four")
    });
  });
});

describe("bare HTTP routing", () => {
  it("routes a quote request without mistaking it for Express", () => {
    expect(
      directHttpToolCall({
        goal: "Compare BTC and ETH on 4h",
        budget_cap: { amount: "1000000", decimals: 6, token: "USDT" }
      })
    ).toMatchObject({ name: "get_quote" });
  });

  it("routes the quoted execute replay without mistaking quote_id for Express params", () => {
    expect(directHttpToolCall({ quote_id: "q_123" })).toEqual({
      name: "execute",
      args: { quote_id: "q_123" }
    });
  });

  it("keeps the documented Express body on Express", () => {
    expect(directHttpToolCall({ symbol: "ETH", timeframe: "4h", prompt: "market snapshot" })).toMatchObject({
      name: "express_run"
    });
  });

  it("advertises the exact paid Projects replay body", () => {
    expect(PROJECT_EXECUTE_HTTP_INPUT).toMatchObject({
      type: "http",
      method: "POST",
      body: { required: ["quote_id"] }
    });
  });
});
