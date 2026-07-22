from firm.models import Constraints, Money, VendorIndexEntry, VendorPerformance, VendorService
from firm.sourcing import select_service, PerformanceStore, effective_score, rank_candidates


def vendor(agent_id: str, score: int) -> VendorIndexEntry:
    return VendorIndexEntry(
        agent_id=agent_id,
        name=agent_id,
        endpoint=f"http://example.com/{agent_id}",
        services=[VendorService(tool="launch_brief", capability="token_launch", price=Money.usdt(100_000))],
        kya_base_score=score,
        flags=[],
        last_verified_at="2026-07-18T00:00:00Z",
    )


def test_effective_score_clamps_adjustment() -> None:
    assert effective_score(vendor("a", 95), VendorPerformance(agent_id="a", adjustment=10)) == 100


def test_rank_candidates_filters_min_score_and_orders_descending() -> None:
    accepted, rejected = rank_candidates(
        [vendor("low", 41), vendor("high", 80)],
        {},
        "token_launch",
        Constraints(min_vendor_score=60),
    )

    assert [item.agent_id for item in accepted] == ["high"]
    assert rejected == [{"agent_id": "low", "reason": "trust score 41 below minimum 60"}]


def test_firing_decrements_immediately() -> None:
    store = PerformanceStore({})
    record = store.record_validation_failure("flaky")

    assert record.validation_failures == 1
    assert record.adjustment == -10


# --- service selection ------------------------------------------------------
# CoinAnk #2013 publishes 80 services, every one tagged market_snapshot. The old
# code took the first, which is getUsBtcEtf, so an ETH request was answered with
# Bitcoin ETF data and a reviewer was billed for it twice. The sibling it should
# have picked was live and payable the whole time.

# Built from the REAL model, not a stand-in. A hand-rolled fake carrying an
# `endpoint` attribute is exactly what let this ship broken: the tests passed
# while production raised AttributeError on every single job, because
# VendorService has no such field. Use the type the code will actually receive.
def _svc(tool, capability="market_snapshot", endpoint=None):
    return VendorService(
        tool=tool,
        capability=capability,
        endpoint=endpoint,
        price=Money(amount="10000", decimals=6, token="USDT"),
    )


def _coinank():
    return [
        _svc("US BTC ETF", endpoint="https://open-api.coinank.com/api/etf/getUsBtcEtf"),
        _svc("US ETH ETF", endpoint="https://open-api.coinank.com/api/etf/getUsEthEtf"),
        _svc("Pair Last Price", endpoint="https://open-api.coinank.com/api/instruments/getLastPrice"),
        _svc("News Feed", capability="news", endpoint="https://example.invalid/news"),
    ]


def test_eth_request_picks_the_eth_endpoint():
    chosen = select_service(_coinank(), "market_snapshot", {"symbol": "ETH"})
    assert chosen.tool == "US ETH ETF"


def test_btc_request_still_picks_the_btc_endpoint():
    chosen = select_service(_coinank(), "market_snapshot", {"symbol": "BTC"})
    assert chosen.tool == "US BTC ETF"


def test_unknown_symbol_prefers_a_symbol_agnostic_service():
    """Never hand a SOL request to an endpoint that announces Bitcoin."""
    chosen = select_service(_coinank(), "market_snapshot", {"symbol": "SOL"})
    assert chosen.tool == "Pair Last Price"


def test_no_request_keeps_the_previous_first_match_behaviour():
    chosen = select_service(_coinank(), "market_snapshot", None)
    assert chosen.tool == "US BTC ETF"


def test_capability_filter_still_applies():
    assert select_service(_coinank(), "news", {"symbol": "ETH"}).tool == "News Feed"
    assert select_service(_coinank(), "nonexistent", {"symbol": "ETH"}) is None


def test_wrong_asset_endpoint_is_the_last_resort_not_the_first():
    """With only a BTC endpoint available, an ETH request must rank it last."""
    only_btc = [_svc("US BTC ETF"), _svc("Generic Feed")]
    chosen = select_service(only_btc, "market_snapshot", {"symbol": "ETH"})
    assert chosen.tool == "Generic Feed"


def test_the_selected_service_carries_its_own_endpoint():
    """Selecting the right service is useless if the call posts elsewhere.

    VendorService used to drop the per-service endpoint, so the HTTP call fell
    back to the vendor-wide URL -- CoinAnk's, which is its Bitcoin ETF endpoint.
    An ETH request selected the ETH service and then posted to the BTC one. The
    selection and the call must agree, so assert on the URL, not the tool name.
    """
    chosen = select_service(_coinank(), "market_snapshot", {"symbol": "ETH"})
    assert chosen.endpoint == "https://open-api.coinank.com/api/etf/getUsEthEtf"

    chosen = select_service(_coinank(), "market_snapshot", {"symbol": "BTC"})
    assert chosen.endpoint == "https://open-api.coinank.com/api/etf/getUsBtcEtf"


def test_index_entries_parse_their_per_service_endpoints():
    """The real index file must survive the model, or the fix is inert."""
    import json
    from pathlib import Path

    from firm.models import VendorIndexEntry

    payload = json.loads(Path("../../data/vendor-index.json").read_text())
    vendors = payload["vendors"] if isinstance(payload, dict) and "vendors" in payload else payload
    coinank = next(v for v in vendors if str(v["agent_id"]) == "2013")
    entry = VendorIndexEntry.model_validate(coinank)
    endpoints = {s.endpoint for s in entry.services}
    assert len(endpoints) > 1, "per-service endpoints were dropped by the model"
    assert any(e and "getUsEthEtf" in e for e in endpoints)
