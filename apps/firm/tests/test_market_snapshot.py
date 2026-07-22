from datetime import datetime, timedelta, timezone

import pytest

from firm.market_snapshot import (
    MarketSnapshotError,
    build_market_snapshot,
    candles_from_price_series,
    normalise_market_request,
    vendor_request,
)
from firm.validation import validate


def candles(count: int = 30, *, latest: datetime | None = None) -> list[list[str]]:
    latest = latest or datetime.now(timezone.utc)
    first_ms = int(latest.timestamp() * 1000) - (count - 1) * 14_400_000
    rows = []
    for index in range(count):
        base = 3_000 + index * 5
        rows.append(
            [
                str(first_ms + index * 14_400_000),
                str(base),
                str(base + 20),
                str(base - 10),
                str(base + 10),
                "100",
                "0",
                "0",
                "1",
            ]
        )
    # OKX returns newest first; the builder must normalize order.
    return list(reversed(rows))


def test_snapshot_uses_exact_symbol_timeframe_and_required_analysis_fields() -> None:
    params = {
        "symbol": "ETH",
        "timeframe": "4h",
        "prompt": "ETH/USD price action, trend, support and resistance",
    }
    snapshot = build_market_snapshot(
        params,
        candles(),
        generated_at=datetime.now(timezone.utc),
        source="test fixture",
        source_url="https://example.test/market-data",
    )

    assert snapshot["symbol"] == "ETH"
    assert snapshot["instrument"] == "ETH-USDT"
    assert snapshot["timeframe"] == "4h"
    assert snapshot["trend"]["direction"] == "bullish"
    assert snapshot["support"]["level"] < snapshot["price"] < snapshot["resistance"]["level"]
    assert "ETH-USDT" in snapshot["price_action"]
    assert validate(snapshot, {"acceptance": "market_snapshot", "request": params}).passed


@pytest.mark.parametrize("missing", ["symbol", "timeframe", "prompt"])
def test_market_request_requires_every_field_before_settlement(missing: str) -> None:
    params = {"symbol": "ETH", "timeframe": "4h", "prompt": "technical snapshot"}
    params.pop(missing)
    with pytest.raises(MarketSnapshotError, match=missing):
        normalise_market_request(params)


def test_market_request_rejects_unsupported_timeframe() -> None:
    with pytest.raises(MarketSnapshotError, match="unsupported timeframe"):
        normalise_market_request({"symbol": "ETH", "timeframe": "13h", "prompt": "snapshot"})


def test_market_request_rejects_an_unrelated_prompt() -> None:
    with pytest.raises(MarketSnapshotError, match="market or technical snapshot"):
        normalise_market_request({"symbol": "ETH", "timeframe": "4h", "prompt": "write launch copy"})


def test_snapshot_rejects_stale_candles_instead_of_stamping_them_fresh() -> None:
    now = datetime.now(timezone.utc)
    with pytest.raises(MarketSnapshotError, match="stale or future-dated"):
        build_market_snapshot(
            {"symbol": "ETH", "timeframe": "4h", "prompt": "market snapshot"},
            candles(latest=now - timedelta(days=2)),
            generated_at=now,
        )


def test_live_sized_hourly_series_can_fulfil_a_four_hour_request() -> None:
    """The paid probe returned 50 rows, so the fixture must not hide that limit."""
    now = datetime.now(timezone.utc)
    now_ms = int(now.timestamp() * 1000)
    rows = [
        {"price": str(1900 + index), "time": str(now_ms - index * 3_600_000)}
        for index in range(50)
    ]
    derived = candles_from_price_series(rows, "4h")
    snapshot = build_market_snapshot(
        {"symbol": "ETH", "timeframe": "4h", "prompt": "price action and trend"},
        derived,
        generated_at=now,
        source="OKLink #2023 purchased price series",
        source_url="https://www.oklink.com/api/v5/explorer/mcp/x402/get_token_price_history",
        minimum_candles=8,
    )

    assert 13 <= len(derived) <= 14
    assert snapshot["analysis_window_buckets"] == len(derived)
    assert snapshot["data_basis"] == "OHLC buckets derived from purchased point-price observations"
    assert "derived price buckets" in snapshot["price_action"]


def test_vendor_request_uses_only_verified_contracts_and_granularities() -> None:
    assert vendor_request("ETH", "4h") == {
        "chainIndex": "1",
        "tokenAddress": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "granularity": "1H",
        "limit": "100",
    }
    with pytest.raises(MarketSnapshotError, match="no verified token source"):
        vendor_request("DOGE", "4h")


def test_deliverable_discloses_the_wrapped_asset_it_was_priced_from():
    """An ETH request is served from WETH's series; the buyer must be told.

    The vendor sells on-chain ERC-20 price history, so ETH is priced via WETH and
    BTC via WBTC. They track their underlying closely and are not the same asset.
    Presenting one as the other without saying so is the same quiet substitution
    that had a reviewer paying for Bitcoin ETF data after asking about ETH.
    """
    from firm.market_snapshot import price_source_asset

    eth = price_source_asset("ETH")
    assert eth is not None
    assert eth["priced_via"] == "WETH"
    assert eth["token_address"] == "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"

    assert price_source_asset("BTC")["priced_via"] == "WBTC"
    assert price_source_asset("DOGE") is None


def test_snapshot_carries_the_disclosure_through_to_the_buyer():
    from datetime import datetime, timezone

    from firm.market_snapshot import (
        build_market_snapshot,
        candles_from_price_series,
        price_source_asset,
    )

    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    rows = [{"price": str(1900 + (i % 9) * 4), "time": str(now - i * 3_600_000)} for i in range(50)]
    snapshot = build_market_snapshot(
        {"symbol": "ETH", "timeframe": "4h", "prompt": "price action and trend"},
        candles_from_price_series(rows, "4h"),
        minimum_candles=8,
        price_source_asset=price_source_asset("ETH"),
    )
    assert snapshot["price_source_asset"]["priced_via"] == "WETH"
