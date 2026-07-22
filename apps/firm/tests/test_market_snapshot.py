from datetime import datetime, timedelta, timezone

import pytest

from firm.market_snapshot import MarketSnapshotError, build_market_snapshot, normalise_market_request
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
