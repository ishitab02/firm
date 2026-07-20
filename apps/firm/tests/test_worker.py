import asyncio
from datetime import datetime, timezone

from firm.cli import DemoProcurer, demo_vendors
from firm.models import (
    Constraints,
    FirmTask,
    JobState,
    Money,
    PayAndCallRequest,
    PayAndCallResponse,
    Quote,
    VendorIndexEntry,
    VendorService,
)
from firm.sourcing import PerformanceStore
from firm.storage import InMemoryCheckpointStore
from firm.worker import run_task


class AlwaysGoodProcurer:
    """Delivers a fresh, valid result for whatever subtask is requested."""

    async def pay_and_call(self, request: PayAndCallRequest) -> PayAndCallResponse:
        return PayAndCallResponse(
            ok=True,
            result={
                "kind": request.tool,
                "checklist": ["delivered item"],
                "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            },
            receipt={
                "amount": request.max_amount.model_dump(),
                "tx": f"SIMULATED:{request.subtask_id}",
                "payment_response": "SIMULATED",
            },
            latency_ms=10,
        )

    async def refund(self, task_id: str, to_address: str, amount: dict[str, object]) -> dict[str, str]:
        return {"tx": f"SIMULATED:refund:{task_id}"}


def _specialist(agent_id: str, capability: str, tool: str) -> VendorIndexEntry:
    return VendorIndexEntry(
        agent_id=agent_id,
        name=agent_id,
        endpoint=f"http://mock.local/{agent_id}",
        services=[VendorService(tool=tool, capability=capability, price=Money.usdt(100_000))],
        kya_base_score=90,
        flags=[],
        last_verified_at="2026-07-18T00:00:00Z",
    )


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


def test_multi_subtask_job_hires_a_specialist_per_subtask() -> None:
    two_subtasks = Quote(
        quote_id="q_multi",
        price=Money.usdt(1_000_000),
        plan_summary=[
            {"subtask": "market snapshot", "capability": "market_snapshot"},
            {"subtask": "launch brief", "capability": "token_launch"},
        ],
        valid_until=datetime.now(timezone.utc),
    )
    task = FirmTask(task_id="t_multi", goal="market + launch", quote=two_subtasks, state=JobState.PAID)

    completed = asyncio.run(
        run_task(
            task,
            vendors=[
                _specialist("market-vendor", "market_snapshot", "market_snapshot"),
                _specialist("launch-vendor", "token_launch", "launch_brief"),
            ],
            store=InMemoryCheckpointStore(),
            performance=PerformanceStore({}),
            procurer=AlwaysGoodProcurer(),
        )
    )

    assert completed.state == JobState.COMPLETE
    assert completed.deliverable is not None
    subtasks = completed.deliverable["result"]["subtasks"]
    assert [s["capability"] for s in subtasks] == ["market_snapshot", "token_launch"]
    assert [s["agent_id"] for s in subtasks] == ["market-vendor", "launch-vendor"]
    # One hire per subtask, and provenance economics summed both vendor costs.
    assert completed.provenance is not None
    assert len(completed.provenance.hires) == 2


def test_multi_subtask_job_refunds_if_any_subtask_cannot_be_filled() -> None:
    # Only a market vendor exists; the launch subtask has no candidate, so the
    # whole job must refund rather than deliver a partial result.
    two_subtasks = Quote(
        quote_id="q_partial",
        price=Money.usdt(1_000_000),
        plan_summary=[
            {"subtask": "market snapshot", "capability": "market_snapshot"},
            {"subtask": "launch brief", "capability": "token_launch"},
        ],
        valid_until=datetime.now(timezone.utc),
    )
    task = FirmTask(task_id="t_partial", goal="market + launch", quote=two_subtasks, state=JobState.PAID)

    completed = asyncio.run(
        run_task(
            task,
            vendors=[_specialist("market-vendor", "market_snapshot", "market_snapshot")],
            store=InMemoryCheckpointStore(),
            performance=PerformanceStore({}),
            procurer=AlwaysGoodProcurer(),
        )
    )

    assert completed.state == JobState.FAILED_REFUNDED
    assert completed.deliverable is None


def test_refund_targets_the_captured_buyer_address() -> None:
    # A job that captured a real payer must refund to that payer, not the
    # placeholder default.
    strict = quote()
    strict.constraints = Constraints(min_vendor_score=95)
    strict.buyer_address = "0xBUYER0000000000000000000000000000000001"
    task = FirmTask(task_id="t_refund_addr", goal="ship firm", quote=strict, state=JobState.PAID)

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
    assert completed.refund is not None
    assert completed.refund["to_address"] == "0xBUYER0000000000000000000000000000000001"


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
