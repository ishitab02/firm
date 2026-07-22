import { describe, expect, it } from "vitest";

import {
  directHttpToolCall,
  PROJECT_EXECUTE_HTTP_INPUT,
  projectSpecFromGoal
} from "./project-args.js";

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
