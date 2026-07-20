from typing import Any, TypedDict

from .models import (
    BooksReceipt,
    Economics,
    FirmTask,
    HireReceipt,
    JobState,
    Money,
    PayAndCallRequest,
    ProvenanceReceipt,
    ValidationResult,
    VendorFiring,
    VendorIndexEntry,
    VendorRejection,
)
from .config import get_settings
from .procurer import Procurer, SimulatedProcurer
from .sourcing import PerformanceStore, rank_candidates
from .storage import CheckpointStore
from .validation import validate


class FirmGraphState(TypedDict, total=False):
    task: FirmTask
    vendors: list[VendorIndexEntry]
    rejected: list[VendorRejection]
    fired: list[VendorFiring]
    hires: list[HireReceipt]
    procurer: Procurer
    store: CheckpointStore
    performance: PerformanceStore
    error: str


def _sum_money(items: list[Money]) -> Money:
    return Money.usdt(sum(item.units() for item in items))


def planning_node(state: FirmGraphState) -> FirmGraphState:
    store = state["store"]
    task = state["task"]
    store.transition(task, JobState.PLANNING, "plan accepted from quote")
    return state


def sourcing_node(state: FirmGraphState) -> FirmGraphState:
    task = state["task"]
    store = state["store"]
    capability = task.quote.plan_summary[0].capability
    candidates, rejected = rank_candidates(
        state["vendors"],
        state["performance"].records,
        capability,
        # The buyer's constraints ride on the quote (min vendor score, banned
        # categories). This is what makes a buyer's "min_vendor_score: 80"
        # actually filter, rather than silently falling back to the default.
        constraints=task.quote.constraints,
    )
    state["vendors"] = candidates
    state["rejected"] = [VendorRejection(**item) for item in rejected]
    store.transition(task, JobState.SOURCING, f"ranked {len(candidates)} candidate vendors")
    return state


def vetting_node(state: FirmGraphState) -> FirmGraphState:
    task = state["task"]
    state["store"].transition(task, JobState.VETTING, "trust filters applied")
    return state


async def procuring_node(state: FirmGraphState) -> FirmGraphState:
    task = state["task"]
    store = state["store"]
    procurer = state.get("procurer") or SimulatedProcurer()
    subtask = task.quote.plan_summary[0]

    store.transition(task, JobState.PROCURING, "starting vendor procurement", subtask.subtask)
    for vendor in state["vendors"]:
        service = next(
            (candidate for candidate in vendor.services if candidate.capability == subtask.capability),
            None,
        )
        if service is None:
            continue
        response = await procurer.pay_and_call(
            PayAndCallRequest(
                vendor_endpoint=vendor.endpoint,
                tool=service.tool,
                args={"goal": task.goal},
                max_amount=service.price,
                task_id=task.task_id,
                subtask_id=subtask.subtask,
            )
        )
        if not response.ok or response.result is None or response.receipt is None:
            state["performance"].record_timeout(vendor.agent_id)
            continue

        validation = validate(response.result, {"acceptance": subtask.subtask})
        hire = HireReceipt(
            agent_id=vendor.agent_id,
            subtask=subtask.subtask,
            cost=response.receipt.amount,
            tx=response.receipt.tx,
            validation={"passed": validation.passed, "checks": validation.checks_run},
        )
        state.setdefault("hires", []).append(hire)

        if not validation.passed:
            state["performance"].record_validation_failure(vendor.agent_id)
            state.setdefault("fired", []).append(
                VendorFiring(
                    agent_id=vendor.agent_id,
                    subtask=subtask.subtask,
                    reason=_validation_reason(validation),
                    cost_absorbed=response.receipt.amount,
                )
            )
            store.transition(
                task,
                JobState.PROCURING,
                f"fired {vendor.agent_id}; validation failed; trying next candidate",
                subtask.subtask,
            )
            continue

        state["performance"].record_success(vendor.agent_id)
        task.deliverable = response.result
        return state

    state["error"] = "candidates exhausted"
    return state


def validating_node(state: FirmGraphState) -> FirmGraphState:
    task = state["task"]
    if task.deliverable:
        state["store"].transition(task, JobState.VALIDATING, "accepted validated vendor output")
    else:
        state["store"].transition(task, JobState.REFUNDING, "all candidates exhausted")
    return state


def assembling_node(state: FirmGraphState) -> FirmGraphState:
    task = state["task"]
    if not task.deliverable:
        return state
    task.deliverable = {
        "goal": task.goal,
        "result": task.deliverable,
        "summary": "Firm assembled the validated vendor output.",
    }
    state["store"].transition(task, JobState.ASSEMBLING, "assembled final deliverable")
    return state


def booking_node(state: FirmGraphState) -> FirmGraphState:
    task = state["task"]
    guarantee_status = "delivered" if task.deliverable else "refunded"
    state["store"].transition(
        task,
        JobState.BOOKING if task.deliverable else JobState.REFUNDING,
        "generated disclosed books receipt",
    )
    task.provenance = build_provenance(task, state, guarantee_status)
    state["store"].transition(
        task,
        JobState.COMPLETE if task.deliverable else JobState.FAILED_REFUNDED,
        "run complete" if task.deliverable else "refund issued",
    )
    return state


async def refunding_node(state: FirmGraphState) -> FirmGraphState:
    task = state["task"]
    if task.deliverable:
        return state
    procurer = state.get("procurer") or SimulatedProcurer()
    settings = get_settings()
    # Refund the actual buyer captured at execute. Only fall back to the
    # configured default when there is no verified payer (a bypassed run).
    refund_to = task.quote.buyer_address or settings.default_refund_address
    refund = await procurer.refund(
        task_id=task.task_id,
        to_address=refund_to,
        amount=task.quote.price.model_dump(mode="json"),
    )
    task.refund = {
        "amount": task.quote.price.model_dump(mode="json"),
        "tx": refund["tx"],
        "to_address": refund_to,
    }
    state["store"].transition(task, JobState.REFUNDED, f"refund issued: {refund['tx']}")
    return state


def build_provenance(
    task: FirmTask,
    state: FirmGraphState,
    guarantee_status: str,
) -> ProvenanceReceipt:
    vendor_costs = _sum_money([hire.cost for hire in state.get("hires", [])])
    books_cost = Money.usdt(50_000)
    actual_costs = Money.usdt(vendor_costs.units() + books_cost.units())
    margin = task.quote.price.units() - actual_costs.units()
    return ProvenanceReceipt(
        task_id=task.task_id,
        goal=task.goal,
        quote={"price": task.quote.price.model_dump(), "quoted_at": task.quote.quoted_at.isoformat()},
        vendors_vetted=len(state.get("vendors", [])) + len(state.get("rejected", [])),
        vendors_rejected=state.get("rejected", []),
        vendors_fired=state.get("fired", []),
        hires=state.get("hires", []),
        economics=Economics(
            user_price=task.quote.price,
            actual_vendor_costs=actual_costs,
            margin_retained_or_absorbed={
                "amount": str(abs(margin)),
                "sign": "retained" if margin >= 0 else "absorbed",
            },
        ),
        books=BooksReceipt(
            cost=books_cost,
            tx="SIMULATED:treasury-books",
            statement="SIMULATED books statement until live Treasury call is human-enabled",
        ),
        guarantee_status=guarantee_status,  # type: ignore[arg-type]
    )


def build_graph() -> Any:
    try:
        from langgraph.graph import END, StateGraph
    except ImportError as exc:
        raise RuntimeError("langgraph is not installed; run `uv sync` in apps/firm") from exc

    graph = StateGraph(FirmGraphState)
    graph.add_node("planning", planning_node)
    graph.add_node("sourcing", sourcing_node)
    graph.add_node("vetting", vetting_node)
    graph.add_node("procuring", procuring_node)
    graph.add_node("validating", validating_node)
    graph.add_node("assembling", assembling_node)
    graph.add_node("booking", booking_node)
    graph.add_node("refunding", refunding_node)
    graph.set_entry_point("planning")
    graph.add_edge("planning", "sourcing")
    graph.add_edge("sourcing", "vetting")
    graph.add_edge("vetting", "procuring")
    graph.add_edge("procuring", "validating")
    graph.add_conditional_edges(
        "validating",
        lambda state: "assembling" if state["task"].deliverable else "booking",
        {"assembling": "assembling", "booking": "booking"},
    )
    graph.add_edge("assembling", "booking")
    graph.add_edge("booking", END)
    return graph.compile()


def _validation_reason(result: ValidationResult) -> str:
    return "validation failed: " + ", ".join(failure.check for failure in result.failures)
