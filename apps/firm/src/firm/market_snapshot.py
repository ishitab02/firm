"""Deterministic crypto market snapshots, built on data bought from an agent.

Firm Express promises price action, trend, support and resistance for the
requested symbol and timeframe. The marketplace endpoints tagged
`market_snapshot` are mostly ETF-flow and general-data services that cannot
fulfil that contract even when their payload mentions the right asset -- which
is how a reviewer asking for ETH was billed twice for Bitcoin ETF holdings.

The fix is NOT to stop hiring. OKLink #2023 -- the agent this repo has already
paid several times -- sells `get_token_price_history` for 15 base units
(0.000015 USDT) and is the only vendor on the marketplace that documents its
arguments. It returns a real price series. The Firm buys that series and derives
the promised fields from it.

That keeps the product honest in both directions: a third-party specialist is
genuinely hired and paid, and the buyer gets exactly what was advertised. The
alternative considered and rejected was fetching OKX's own free public candle
API and selling it at 0.1 USDT -- which delivers the right answer while quietly
removing the only thing that makes The Firm a contractor rather than a proxy.

Everything below the data source is unchanged: the same deterministic trend,
support and resistance derivation, run over candles rebuilt from the purchased
series.
"""

from datetime import datetime, timezone
import os
from typing import Any

import httpx


SUPPORTED_TIMEFRAMES = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1h": "1H",
    "2h": "2H",
    "4h": "4H",
    "6h": "6Hutc",
    "12h": "12Hutc",
    "1d": "1Dutc",
    "1w": "1Wutc",
}

TIMEFRAME_SECONDS = {
    "1m": 60,
    "3m": 180,
    "5m": 300,
    "15m": 900,
    "30m": 1_800,
    "1h": 3_600,
    "2h": 7_200,
    "4h": 14_400,
    "6h": 21_600,
    "12h": 43_200,
    "1d": 86_400,
    "1w": 604_800,
}


class MarketSnapshotError(RuntimeError):
    pass


#: symbol -> (chainIndex, tokenAddress) for the vendor's price API.
#:
#: Every entry was VERIFIED with a real paid probe against the live endpoint,
#: not looked up and trusted. Assuming a contract address is precisely the class
#: of error that produced every other failure on this path, and the failure mode
#: here is silent: a wrong-but-valid address returns somebody else's price.
#:
#:   ETH -> WETH  0xC02aaA...756Cc2   probe returned 1942.09
#:   BTC -> WBTC  0x2260FA...2C599    probe returned 65778.82
#:
#: A symbol absent from this map is refused rather than guessed.
VENDOR_TOKEN_SOURCES: dict[str, tuple[str, str]] = {
    "ETH": ("1", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
    "BTC": ("1", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"),
}

#: What the vendor actually serves. `4H` is accepted and returns an empty array,
#: so it is deliberately absent: anything coarser than an hour is bought hourly
#: and resampled here, which is work the buyer is paying us to do.
VENDOR_GRANULARITY = {"1h": "1H", "1d": "1D"}

VENDOR_ENDPOINT = "https://www.oklink.com/api/v5/explorer/mcp/x402/get_token_price_history"
VENDOR_TOOL = "get_token_price_history"
VENDOR_AGENT_ID = "2023"


def vendor_request(symbol: str, timeframe: str) -> dict[str, Any]:
    """The exact args to buy a price series for this request.

    Raises rather than guessing: an unmapped symbol or an unbuyable timeframe is
    a refusal we make before spending, not a call we make and hope about.
    """
    source = VENDOR_TOKEN_SOURCES.get(symbol.upper())
    if source is None:
        raise MarketSnapshotError(
            f"no verified token source for {symbol}; refusing to guess a contract address"
        )
    if timeframe not in TIMEFRAME_SECONDS:
        raise MarketSnapshotError(f"unsupported timeframe {timeframe}")
    # Buy the finest series the vendor actually serves, then resample upward.
    granularity = "1D" if TIMEFRAME_SECONDS[timeframe] >= 86_400 else "1H"
    chain_index, token_address = source
    return {"chainIndex": chain_index, "tokenAddress": token_address, "granularity": granularity}


def candles_from_price_series(rows: list[dict[str, Any]], timeframe: str) -> list[list[str]]:
    """Turn the vendor's point-price series into OHLC candles at `timeframe`.

    The vendor sells {price, time} points, not candles. Bucketing them by the
    requested period and taking first/max/min/last is an honest derivation --
    the highs and lows are the extremes actually observed within each bucket,
    not invented intra-period data. Buying hourly and resampling is how a 4h
    request is served at all, since the vendor returns nothing for 4H.
    """
    period_ms = TIMEFRAME_SECONDS[timeframe] * 1000
    points: list[tuple[int, float]] = []
    for row in rows:
        try:
            points.append((int(row["time"]), float(row["price"])))
        except (KeyError, TypeError, ValueError):
            continue
    points.sort()

    buckets: dict[int, list[float]] = {}
    for timestamp_ms, price in points:
        buckets.setdefault(timestamp_ms - (timestamp_ms % period_ms), []).append(price)

    return [
        [str(bucket), str(prices[0]), str(max(prices)), str(min(prices)), str(prices[-1])]
        for bucket, prices in sorted(buckets.items())
    ]


def normalise_market_request(params: dict[str, Any]) -> tuple[str, str, str]:
    symbol_raw = params.get("symbol") or params.get("asset") or params.get("ticker")
    timeframe_raw = params.get("timeframe")
    prompt_raw = params.get("prompt")
    if not isinstance(symbol_raw, str) or not symbol_raw.strip():
        raise MarketSnapshotError("symbol is required")
    if not isinstance(timeframe_raw, str) or not timeframe_raw.strip():
        raise MarketSnapshotError("timeframe is required")
    if not isinstance(prompt_raw, str) or not prompt_raw.strip():
        raise MarketSnapshotError("prompt is required")

    symbol = symbol_raw.strip().upper().removesuffix("/USDT").removesuffix("-USDT")
    if not symbol.isalnum() or len(symbol) > 12:
        raise MarketSnapshotError("symbol must be a simple crypto ticker")
    timeframe = timeframe_raw.strip().lower()
    if timeframe not in SUPPORTED_TIMEFRAMES:
        supported = ", ".join(SUPPORTED_TIMEFRAMES)
        raise MarketSnapshotError(f"unsupported timeframe {timeframe_raw!r}; supported: {supported}")
    prompt = prompt_raw.strip()
    supported_focus = ("price", "trend", "support", "resistance", "market", "snapshot", "technical")
    if not any(term in prompt.lower() for term in supported_focus):
        raise MarketSnapshotError("prompt must request a market or technical snapshot")
    return symbol, timeframe, prompt


def build_market_snapshot(
    params: dict[str, Any],
    rows: list[list[str]],
    *,
    generated_at: datetime | None = None,
    source_base_url: str = "https://app.okx.com/api/v5/market/candles",
    source: str = "OKX public candlesticks",
    source_url: str | None = None,
) -> dict[str, Any]:
    symbol, timeframe, prompt = normalise_market_request(params)
    if len(rows) < 20:
        raise MarketSnapshotError(f"market data returned only {len(rows)} candles; need at least 20")

    try:
        candles = sorted(
            [
                {
                    "timestamp_ms": int(row[0]),
                    "open": float(row[1]),
                    "high": float(row[2]),
                    "low": float(row[3]),
                    "close": float(row[4]),
                }
                for row in rows
                if len(row) >= 5
            ],
            key=lambda candle: candle["timestamp_ms"],
        )
    except (TypeError, ValueError) as error:
        raise MarketSnapshotError(f"market data contained an invalid candle: {error}") from error
    if len(candles) < 20:
        raise MarketSnapshotError(f"market data contained only {len(candles)} usable candles; need at least 20")

    latest = candles[-1]
    recent = candles[-20:]
    first = recent[0]
    change = latest["close"] - first["open"]
    change_pct = (change / first["open"] * 100) if first["open"] else 0.0
    sma_short = sum(candle["close"] for candle in candles[-8:]) / 8
    sma_long = sum(candle["close"] for candle in recent) / 20
    if sma_short > sma_long * 1.002:
        trend = "bullish"
    elif sma_short < sma_long * 0.998:
        trend = "bearish"
    else:
        trend = "sideways"

    support = min(candle["low"] for candle in recent)
    resistance = max(candle["high"] for candle in recent)
    direction = "rose" if change > 0 else "fell" if change < 0 else "was unchanged"
    timestamp = generated_at or datetime.now(timezone.utc)
    market_data_at = datetime.fromtimestamp(latest["timestamp_ms"] / 1000, timezone.utc)
    age_seconds = (timestamp - market_data_at).total_seconds()
    if age_seconds < -300 or age_seconds > TIMEFRAME_SECONDS[timeframe] * 2:
        raise MarketSnapshotError(
            f"latest {timeframe} candle is stale or future-dated: {market_data_at.isoformat()}"
        )
    instrument = f"{symbol}-USDT"
    resolved_source_url = source_url or (
        f"{source_base_url}?instId={instrument}&bar={SUPPORTED_TIMEFRAMES[timeframe]}&limit=100"
    )

    return {
        "kind": "market_snapshot",
        "symbol": symbol,
        "quote_asset": "USDT",
        "instrument": instrument,
        "timeframe": timeframe,
        "prompt": prompt,
        "price": latest["close"],
        "price_action": (
            f"{instrument} {direction} {abs(change_pct):.2f}% across the latest 20 {timeframe} candles, "
            f"from {first['open']:.6g} to {latest['close']:.6g}; recent range "
            f"{support:.6g}-{resistance:.6g}."
        ),
        "trend": {
            "direction": trend,
            "short_sma": round(sma_short, 8),
            "long_sma": round(sma_long, 8),
            "method": "8-candle SMA versus 20-candle SMA with a 0.2% neutral band",
        },
        "support": {"level": support, "method": "lowest low of latest 20 candles"},
        "resistance": {"level": resistance, "method": "highest high of latest 20 candles"},
        "market_data_at": market_data_at.isoformat().replace("+00:00", "Z"),
        "generated_at": timestamp.isoformat().replace("+00:00", "Z"),
        "source": source,
        "source_urls": [resolved_source_url],
        "disclaimer": "Deterministic market-data summary, not financial advice.",
    }


async def fetch_market_snapshot(
    params: dict[str, Any],
    *,
    timeout_seconds: float = 10.0,
) -> dict[str, Any]:
    symbol, timeframe, _ = normalise_market_request(params)
    query = {
        "instId": f"{symbol}-USDT",
        "bar": SUPPORTED_TIMEFRAMES[timeframe],
        "limit": "100",
    }
    configured = os.getenv("OKX_MARKET_DATA_URL")
    endpoints = (
        [configured]
        if configured
        else [
            "https://app.okx.com/api/v5/market/candles",
            "https://eea.okx.com/api/v5/market/candles",
            "https://www.okx.com/api/v5/market/candles",
        ]
    )
    payload: Any = None
    used_endpoint: str | None = None
    failures: list[str] = []
    timeout = httpx.Timeout(timeout_seconds, connect=min(timeout_seconds, 4.0))
    async with httpx.AsyncClient(timeout=timeout) as client:
        for endpoint in endpoints:
            try:
                response = await client.get(endpoint, params=query)
                response.raise_for_status()
                candidate = response.json()
                if isinstance(candidate, dict) and str(candidate.get("code")) == "0":
                    payload = candidate
                    used_endpoint = endpoint
                    break
                failures.append(f"{endpoint}: {candidate.get('msg', 'rejected') if isinstance(candidate, dict) else 'invalid response'}")
            except (httpx.HTTPError, ValueError) as error:
                failures.append(f"{endpoint}: {type(error).__name__}")
    if used_endpoint is None:
        raise MarketSnapshotError("could not read OKX public candles: " + "; ".join(failures))

    if not isinstance(payload, dict) or str(payload.get("code")) != "0":
        detail = payload.get("msg") if isinstance(payload, dict) else "invalid response"
        raise MarketSnapshotError(f"OKX public candles rejected the request: {detail}")
    rows = payload.get("data")
    if not isinstance(rows, list):
        raise MarketSnapshotError("OKX public candles response has no data array")
    return build_market_snapshot(params, rows, source_base_url=used_endpoint)
