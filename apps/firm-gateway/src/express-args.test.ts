import { describe, expect, it } from "vitest";

import { directExpressCall, expressInputFailure, normaliseExpressArgs } from "./express-args.js";

describe("Firm Express request contract", () => {
  it("preserves the listing's flat symbol/timeframe/prompt body", () => {
    const call = directExpressCall({
      symbol: "ETH",
      timeframe: "4h",
      prompt: "price action, trend, support and resistance"
    });
    expect(call).toEqual({
      job_type: "market_snapshot",
      params: {
        symbol: "ETH",
        timeframe: "4h",
        prompt: "price action, trend, support and resistance"
      }
    });
    expect(expressInputFailure(call!)).toBeNull();
  });

  it.each(["symbol", "timeframe", "prompt"])("rejects a paid replay missing %s", (missing) => {
    const params: Record<string, string> = {
      symbol: "ETH",
      timeframe: "4h",
      prompt: "technical snapshot"
    };
    delete params[missing];
    const call = normaliseExpressArgs({ job_type: "market_snapshot", params });
    expect(expressInputFailure(call!)).toContain(missing);
  });

  it("rejects unsupported timeframes", () => {
    const call = normaliseExpressArgs({
      job_type: "market_snapshot",
      params: { symbol: "ETH", timeframe: "13h", prompt: "snapshot" }
    });
    expect(expressInputFailure(call!)).toContain("unsupported timeframe");
  });

  it("rejects symbols without a paid, verified token mapping", () => {
    const call = normaliseExpressArgs({
      job_type: "market_snapshot",
      params: { symbol: "DOGE", timeframe: "4h", prompt: "snapshot" }
    });
    expect(expressInputFailure(call!)).toContain("supported: BTC, ETH");
  });

  it("does not advertise intraday periods the paid source cannot fulfil", () => {
    const call = normaliseExpressArgs({
      job_type: "market_snapshot",
      params: { symbol: "ETH", timeframe: "15m", prompt: "snapshot" }
    });
    expect(expressInputFailure(call!)).toContain("supported: 1h, 2h, 4h, 1d");
  });

  it("rejects prompts outside the listed market-snapshot product", () => {
    const call = normaliseExpressArgs({
      job_type: "market_snapshot",
      params: { symbol: "ETH", timeframe: "4h", prompt: "write a token launch plan" }
    });
    expect(expressInputFailure(call!)).toContain("market or technical snapshot");
  });
});
