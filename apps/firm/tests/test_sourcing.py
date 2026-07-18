from firm.models import Constraints, Money, VendorIndexEntry, VendorPerformance, VendorService
from firm.sourcing import PerformanceStore, effective_score, rank_candidates


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
