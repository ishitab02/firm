import { describe, expect, it } from "vitest";

import {
  directExpressCall,
  EXPRESS_HTTP_INPUT,
  expressInputFailure,
  normaliseExpressArgs,
  SUPPORTED_MARKET_SYMBOLS,
  SUPPORTED_MARKET_TIMEFRAMES
} from "./express-args.js";

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

/**
 * The 402 challenge is a promise about what the endpoint accepts. These tests
 * exist because it once promised more than it accepted: twelve timeframes
 * advertised, four honoured. Nothing failed — the schema and the validator were
 * separate literals, and only a buyer would ever have noticed.
 *
 * So these do not assert the schema's contents. They round-trip every value it
 * advertises through the validator that actually gates the request.
 */
describe("the advertised input schema matches what is enforced", () => {
  it("declares the method, because buyer tooling probes GET by default", () => {
    expect(EXPRESS_HTTP_INPUT.type).toBe("http");
    expect(EXPRESS_HTTP_INPUT.method).toBe("POST");
    expect(EXPRESS_HTTP_INPUT.bodyType).toBe("json");
  });

  it("names the three fields the listing documents, all required", () => {
    expect([...EXPRESS_HTTP_INPUT.body.required]).toEqual(["symbol", "timeframe", "prompt"]);
    expect(Object.keys(EXPRESS_HTTP_INPUT.body.properties)).toEqual(["symbol", "timeframe", "prompt"]);
  });

  it("accepts every symbol it advertises", () => {
    for (const symbol of EXPRESS_HTTP_INPUT.body.properties.symbol.enum) {
      const call = normaliseExpressArgs({
        job_type: "market_snapshot",
        params: { symbol, timeframe: "4h", prompt: "market snapshot" }
      });
      expect(expressInputFailure(call!), `advertised symbol ${symbol} was refused`).toBeNull();
    }
  });

  it("accepts every timeframe it advertises", () => {
    for (const timeframe of EXPRESS_HTTP_INPUT.body.properties.timeframe.enum) {
      const call = normaliseExpressArgs({
        job_type: "market_snapshot",
        params: { symbol: "ETH", timeframe, prompt: "market snapshot" }
      });
      expect(expressInputFailure(call!), `advertised timeframe ${timeframe} was refused`).toBeNull();
    }
  });

  it("advertises every value it accepts, so the schema is not quietly narrower", () => {
    expect([...EXPRESS_HTTP_INPUT.body.properties.symbol.enum]).toEqual([...SUPPORTED_MARKET_SYMBOLS]);
    expect([...EXPRESS_HTTP_INPUT.body.properties.timeframe.enum]).toEqual([...SUPPORTED_MARKET_TIMEFRAMES]);
  });
});
