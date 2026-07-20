import asyncio
from datetime import datetime, timezone

from firm.cli import DemoProcurer, demo_vendors
from firm.models import Constraints, FirmTask, JobState, Money, Quote
from firm.sourcing import PerformanceStore
from firm.storage import InMemoryCheckpointStore
from firm.worker import run_task


def quote() -> Quote:
    return Quote(
        quote_id="q_worker_test",
        price=Money.usdt(600_000),
        plan_summary=[{"subtask": "launch brief", "capability": "token_launch"}],
        valid_until=datetime.now(timezone.utc),
        pricing_mode="QUOTED_AMOUNT",
    )


def test_worker_refunds_when_candidates_exhausted() -> None:
    completed = asyncio.run(run_refund_task())

    assert completed.state == JobState.FAILED_REFUNDED
    assert completed.refund is not None
    assert completed.refund["tx"].startswith("SIMULATED:refund:")
    assert completed.provenance is not None
    assert completed.provenance.guarantee_status == "refunded"


async def run_refund_task() -> FirmTask:
    task = FirmTask(task_id="t_refund_test", goal="ship firm", quote=quote(), state=JobState.PAID)
    store = InMemoryCheckpointStore()

    return await run_task(
        task,
        vendors=[demo_vendors(prefix="test")[0]],
        store=store,
        performance=PerformanceStore({}),
        procurer=DemoProcurer(),
    )


def test_buyer_constraints_reach_sourcing_and_filter_vendors() -> None:
    # Both demo vendors score below 95, so a strict buyer constraint must reject
    # both and drive a refund. If constraints were dropped on the way to
    # sourcing (the default is 60), the good vendor would deliver instead.
    strict = quote()
    strict.constraints = Constraints(min_vendor_score=95)
    task = FirmTask(task_id="t_constraint_test", goal="ship firm", quote=strict, state=JobState.PAID)

    completed = asyncio.run(
        run_task(
            task,
            vendors=demo_vendors(prefix="test"),
            store=InMemoryCheckpointStore(),
            performance=PerformanceStore({}),
            procurer=DemoProcurer(),
        )
    )

    assert completed.state == JobState.FAILED_REFUNDED
    assert completed.provenance is not None
    assert completed.provenance.vendors_vetted >= 2
    # Every candidate was rejected by the score floor, none hired.
    assert [r.reason for r in completed.provenance.vendors_rejected]
    assert completed.provenance.hires == []
