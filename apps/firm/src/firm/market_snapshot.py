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
from typing import Any

SUPPORTED_TIMEFRAMES = ("1h", "2h", "4h", "1d")

TIMEFRAME_SECONDS = {
    "1h": 3_600,
    "2h": 7_200,
    "4h": 14_400,
    "1d": 86_400,
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

VENDOR_AGENT_ID = "2023"
VENDOR_AGENT_NAME = "Onchain Data Explorer"
VENDOR_SERVICE_NAME = "Historical Token Price"


def price_source_asset(symbol: str) -> dict[str, Any] | None:
    """What the price was actually observed on, for the buyer to see.

    The vendor sells on-chain ERC-20 price history, so an ETH request is served
    from WETH and a BTC request from WBTC. Those track their underlying closely
    but are distinct assets, and silently presenting one as the other is the same
    class of quiet substitution that had a reviewer paying for Bitcoin ETF data
    after asking about ETH. Say it in the deliverable.
    """
    source = VENDOR_TOKEN_SOURCES.get(symbol.upper())
    if source is None:
        return None
    chain_index, token_address = source
    wrapped = {"ETH": "WETH", "BTC": "WBTC"}.get(symbol.upper(), symbol.upper())
    return {
        "priced_via": wrapped,
        "token_address": token_address,
        "chain_index": chain_index,
        "note": f"{symbol.upper()} priced from its wrapped ERC-20 ({wrapped}) on-chain series",
    }


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
    granularity = "1D" if timeframe == "1d" else "1H"
    chain_index, token_address = source
    return {
        "chainIndex": chain_index,
        "tokenAddress": token_address,
        "granularity": granularity,
        # The vendor documents `limit` as optional. Asking for 100 gives a 4h
        # request enough history when honoured; the analysis also handles the
        # 50-row response observed in the paid probe.
        "limit": "100",
    }


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

    buckets: dict[int, list[tuple[int, float]]] = {}
    for timestamp_ms, price in points:
        buckets.setdefault(timestamp_ms - (timestamp_ms % period_ms), []).append((timestamp_ms, price))

    return [
        [
            str(observations[-1][0]),
            str(observations[0][1]),
            str(max(price for _, price in observations)),
            str(min(price for _, price in observations)),
            str(observations[-1][1]),
        ]
        for _, observations in sorted(buckets.items())
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
    source: str = "provided market data",
    source_url: str | None = None,
    minimum_candles: int = 20,
    price_source_asset: dict[str, Any] | None = None,
) -> dict[str, Any]:
    symbol, timeframe, prompt = normalise_market_request(params)
    if len(rows) < minimum_candles:
        raise MarketSnapshotError(
            f"market data returned only {len(rows)} derived price buckets; need at least {minimum_candles}"
        )

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
    if len(candles) < minimum_candles:
        raise MarketSnapshotError(
            f"market data contained only {len(candles)} usable price buckets; need at least {minimum_candles}"
        )

    latest = candles[-1]
    recent = candles[-20:]
    long_window = len(recent)
    short_window = min(8, max(3, long_window // 2))
    first = recent[0]
    change = latest["close"] - first["open"]
    change_pct = (change / first["open"] * 100) if first["open"] else 0.0
    sma_short = sum(candle["close"] for candle in candles[-short_window:]) / short_window
    sma_long = sum(candle["close"] for candle in recent) / long_window
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
    return {
        "kind": "market_snapshot",
        "symbol": symbol,
        "quote_asset": "USDT",
        "instrument": instrument,
        "timeframe": timeframe,
        "prompt": prompt,
        "price": latest["close"],
        "price_action": (
            f"{instrument} {direction} {abs(change_pct):.2f}% across the latest {long_window} "
            f"{timeframe} derived price buckets, "
            f"from {first['open']:.6g} to {latest['close']:.6g}; recent range "
            f"{support:.6g}-{resistance:.6g}."
        ),
        "trend": {
            "direction": trend,
            "short_sma": round(sma_short, 8),
            "long_sma": round(sma_long, 8),
            "method": (
                f"{short_window}-bucket SMA versus {long_window}-bucket SMA "
                "with a 0.2% neutral band"
            ),
        },
        "support": {
            "level": support,
            "method": f"lowest observed price in latest {long_window} derived buckets",
        },
        "resistance": {
            "level": resistance,
            "method": f"highest observed price in latest {long_window} derived buckets",
        },
        "analysis_window_buckets": long_window,
        "data_basis": "OHLC buckets derived from purchased point-price observations",
        # An ETH request is priced from WETH's on-chain series, because that is
        # what the vendor sells. The two track closely and are not the same
        # asset, so the buyer is told rather than left to assume the price came
        # from native ETH.
        **({"price_source_asset": price_source_asset} if price_source_asset else {}),
        "market_data_at": market_data_at.isoformat().replace("+00:00", "Z"),
        "generated_at": timestamp.isoformat().replace("+00:00", "Z"),
        "source": source,
        "source_urls": [source_url] if source_url else [],
        "disclaimer": "Deterministic market-data summary, not financial advice.",
    }
