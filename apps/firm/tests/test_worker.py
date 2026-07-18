import asyncio
from datetime import datetime, timezone

from firm.cli import DemoProcurer, demo_vendors
from firm.models import FirmTask, JobState, Money, Quote
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
