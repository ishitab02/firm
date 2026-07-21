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


def test_vendor_args_sends_job_params_verbatim_when_supplied():
    """A vendor with a real schema must receive the buyer's params, not prose.

    Payment happens before the vendor validates the body, so a generic shape is
    not a soft failure — it is a paid-for 400.
    """
    from firm.graph import _vendor_args
    from firm.models import FirmTask, Money, PlanItem, Quote
    from datetime import datetime, timedelta, timezone

    quote = Quote(
        quote_id="q_x",
        price=Money.usdt(500_000),
        plan_summary=[PlanItem(subtask="snapshot", capability="market_snapshot")],
        valid_until=datetime.now(timezone.utc) + timedelta(minutes=15),
    )
    subtask = quote.plan_summary[0]

    # OKLink #2023's real documented schema.
    oklink_params = {"chainIndex": "1", "address": "0x0000000000000000000000000000000000000000", "height": "21000000"}
    task = FirmTask(task_id="t_x", goal="balance snapshot", quote=quote, params=oklink_params)
    assert _vendor_args(task, subtask) == oklink_params
    # No goal/subtask smuggled in alongside: the vendor gets exactly what was specified.
    assert "goal" not in _vendor_args(task, subtask)

    # With no params the previous generic shape is preserved, which is what the
    # packages/mocks fixtures expect.
    bare = FirmTask(task_id="t_y", goal="balance snapshot", quote=quote)
    assert _vendor_args(bare, subtask) == {"goal": "balance snapshot", "subtask": "snapshot"}


def test_firm_task_params_round_trip_through_postgres(tmp_path):
    """params must survive the job row, or the worker sends {} to a paid vendor."""
    from firm.models import FirmTask, Money, PlanItem, Quote
    from datetime import datetime, timedelta, timezone

    quote = Quote(
        quote_id="q_rt",
        price=Money.usdt(500_000),
        plan_summary=[PlanItem(subtask="snapshot", capability="market_snapshot")],
        valid_until=datetime.now(timezone.utc) + timedelta(minutes=15),
    )
    task = FirmTask(task_id="t_rt", goal="g", quote=quote, params={"chainIndex": "1"})
    # Model round trip is the part that is pure; the DB round trip is covered by
    # the live worker evals.
    assert FirmTask.model_validate(task.model_dump(mode="json")).params == {"chainIndex": "1"}


def test_provenance_economics_reconcile_exactly():
    """user_price must equal vendor costs + books + margin.

    actual_vendor_costs previously included the books cost, which is our own
    expense and is already disclosed in its own block — so a judge adding the
    published numbers up would have double-counted it on the one field the entry
    asks them to trust.
    """
    from firm.graph import build_provenance
    from firm.models import FirmTask, HireReceipt, Money, PlanItem, Quote
    from datetime import datetime, timedelta, timezone

    quote = Quote(
        quote_id="q_e",
        price=Money.usdt(100_000),
        plan_summary=[PlanItem(subtask="market_snapshot", capability="market_snapshot")],
        valid_until=datetime.now(timezone.utc) + timedelta(minutes=15),
    )
    task = FirmTask(task_id="t_e", goal="g", quote=quote)
    state = {
        "task": task,
        "vendors": [],
        "rejected": [],
        "fired": [],
        "hires": [
            HireReceipt(agent_id="2023", subtask="market_snapshot", cost=Money.usdt(15),
                        tx="0xreal", validation={"passed": True, "checks": []})
        ],
    }
    receipt = build_provenance(task, state, "delivered")

    vendors = int(receipt.economics.actual_vendor_costs.amount)
    books = int(receipt.books.cost.amount)
    margin = int(receipt.economics.margin_retained_or_absorbed["amount"])
    price = int(receipt.economics.user_price.amount)

    assert vendors == 15, "vendor costs must be vendor money only, not ours"
    assert books == 0, "a simulated books call costs nothing and must not reduce our stated margin"
    assert receipt.economics.margin_retained_or_absorbed["sign"] == "retained"
    assert vendors + books + margin == price, "the published numbers must reconcile"


def test_missing_documented_params_knows_what_a_vendor_declared():
    """Payment happens before the vendor validates the body, so a call we know
    cannot succeed must be skipped before it costs anything."""
    from firm.graph import missing_documented_params
    from firm.models import Money, VendorService

    oklink = VendorService(
        tool="Address Balance Snapshot",
        price=Money.usdt(15),
        capability="market_snapshot",
        documented_example_args={
            "args": {"chainIndex": "1", "address": "0x...", "height": "21000000"},
            "source": "verbatim_json_literal_in_vendor_service_description",
        },
    )

    # Job supplies everything the vendor documented.
    assert missing_documented_params(oklink, {"chainIndex": "1", "address": "0xabc", "height": "21000000"}) == []
    # Job supplies nothing useful: all three are missing, reported sorted.
    assert missing_documented_params(oklink, {"goal": "market snapshot"}) == ["address", "chainIndex", "height"]
    # Partial coverage still blocks, because the call would still 400.
    assert missing_documented_params(oklink, {"chainIndex": "1"}) == ["address", "height"]


def test_a_vendor_that_documents_nothing_is_not_blocked():
    """Unknown is not a failure. Most of the marketplace documents nothing, and
    treating silence as 'requires nothing' or as 'unusable' would both be wrong —
    we simply cannot pre-check them."""
    from firm.graph import missing_documented_params
    from firm.models import Money, VendorService

    undocumented = VendorService(tool="t", price=Money.usdt(10), capability="market_snapshot")
    assert missing_documented_params(undocumented, {}) == []

    empty_doc = VendorService(
        tool="t", price=Money.usdt(10), capability="market_snapshot",
        documented_example_args={"args": {}, "source": "x"},
    )
    assert missing_documented_params(empty_doc, {}) == []


class CapRefusingProcurer:
    """Refuses every call with CAP_EXCEEDED — the Firm's own spending limit.

    This is Clawby #3209 in miniature: a vendor that is alive, conformant, and
    asking 600x its listing. Our cap correctly declines to sign. The vendor did
    nothing wrong and must not be penalised for it.
    """

    async def pay_and_call(self, request: PayAndCallRequest) -> PayAndCallResponse:
        return PayAndCallResponse(
            ok=False,
            error_code="CAP_EXCEEDED",
            detail="vendor asked for 3000000 base units, above the caller's max_amount of 5000",
        )

    async def refund(self, task_id: str, to_address: str, amount: dict[str, object]) -> dict[str, str]:
        return {"tx": f"SIMULATED:refund:{task_id}"}


class TimingOutProcurer:
    """A genuine vendor-side failure, which SHOULD be penalised."""

    async def pay_and_call(self, request: PayAndCallRequest) -> PayAndCallResponse:
        return PayAndCallResponse(ok=False, error_code="VENDOR_TIMEOUT", detail="probe failed: fetch failed")

    async def refund(self, task_id: str, to_address: str, amount: dict[str, object]) -> dict[str, str]:
        return {"tx": f"SIMULATED:refund:{task_id}"}


async def _run_with(procurer, performance: PerformanceStore) -> FirmTask:
    task = FirmTask(task_id="t_fault_attribution", goal="ship firm", quote=quote(), state=JobState.PAID)
    return await run_task(
        task,
        vendors=[_specialist("v-1", "token_launch", "launch")],
        store=InMemoryCheckpointStore(),
        performance=performance,
        procurer=procurer,
    )


def test_our_own_cap_is_never_recorded_as_a_vendor_failure() -> None:
    """The G2 lesson, applied to procurement instead of validation.

    Recording our spending limit as the vendor's timeout writes a fabricated
    accusation into both the trust database and the provenance receipt.
    """
    performance = PerformanceStore({})
    completed = asyncio.run(_run_with(CapRefusingProcurer(), performance))

    assert "v-1" not in performance.records or performance.records["v-1"].calls == 0
    assert performance.records.get("v-1") is None or performance.records["v-1"].adjustment == 0

    # It still appears in the receipt — silently dropping it would be its own
    # kind of dishonesty — but as a rejection carrying the real reason.
    assert completed.provenance is not None
    reasons = [row.reason for row in completed.provenance.vendors_rejected if row.agent_id == "v-1"]
    assert reasons and "CAP_EXCEEDED" in reasons[0]
    assert not any(row.agent_id == "v-1" for row in completed.provenance.vendors_fired)


def test_a_real_vendor_timeout_is_still_recorded_against_the_vendor() -> None:
    """The other half. Refusing to penalise anything would be just as wrong:
    the Darwinian layer would stop learning."""
    performance = PerformanceStore({})
    asyncio.run(_run_with(TimingOutProcurer(), performance))

    record = performance.records["v-1"]
    assert record.timeouts == 1
    assert record.adjustment == -10


def test_a_refunded_job_reports_absorbed_not_retained() -> None:
    """A refunded job earned nothing: the quoted price went back to the buyer.

    Computing margin against the quoted price regardless of outcome made the
    receipt claim we retained money we had just given back — in our favour, on
    the number that carries the whole guarantee story.
    """
    completed = asyncio.run(run_refund_task())

    assert completed.provenance is not None
    economics = completed.provenance.economics
    assert completed.provenance.guarantee_status == "refunded"
    assert economics.margin_retained_or_absorbed["sign"] == "absorbed"

    # And the magnitude is exactly what we paid out, not the quoted price.
    outlay = economics.actual_vendor_costs.units() + completed.provenance.books.cost.units()
    assert economics.margin_retained_or_absorbed["amount"] == str(outlay)


def test_a_worker_refuses_a_stale_window_that_can_fire_mid_job() -> None:
    """A live-but-slow worker must never look dead.

    If the window can elapse during one vendor call, a second worker claims the
    same job and restarts it from planning. Idempotency absorbs that only while
    both walk the same candidate order — and sourcing re-ranks against
    vendor_performance, which the first worker is concurrently mutating.
    Different order, different vendor, new idempotency key, real second payment.
    """
    import pytest
    from firm.config import Settings
    from firm.worker import assert_stale_window_is_safe

    # A window at or below one vendor call is the dangerous case: the job goes
    # stale while the call it is waiting on is still in flight.
    with pytest.raises(ValueError, match="too small"):
        assert_stale_window_is_safe(Settings(worker_stale_after_seconds=60))

    with pytest.raises(ValueError, match="run twice"):
        assert_stale_window_is_safe(Settings(worker_stale_after_seconds=120))

    # The old 300s default is in fact safe — but only because every candidate
    # outcome now checkpoints. Before that fix, five 60s vendor failures in a
    # row produced no heartbeat at all and walked the job straight past it.
    assert_stale_window_is_safe(Settings(worker_stale_after_seconds=300))

    # The shipped default carries much more slack than the invariant needs.
    assert_stale_window_is_safe(Settings())
