import asyncio
import contextlib
import signal
from dataclasses import dataclass
from pathlib import Path

from .config import Settings
from .graph import FirmGraphState, booking_node, build_graph, refunding_node
from .health import Heartbeat, serve_health
from .models import FirmTask, HireReceipt, JobState, VendorFiring, VendorIndexEntry
from .procurer import HttpProcurer, Procurer
from .sourcing import load_vendor_index
from .storage import PostgresCheckpointStore, PostgresPerformanceStore


@dataclass
class WorkerResult:
    claimed: bool
    task: FirmTask | None = None


# The compiled LangGraph is stateless across runs (all per-job state lives in the
# invocation dict and in Postgres), so build it once and reuse it.
_GRAPH = None


def _graph():
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build_graph()
    return _GRAPH


async def run_task(
    task: FirmTask,
    vendors: list[VendorIndexEntry],
    store: PostgresCheckpointStore,
    performance: PostgresPerformanceStore,
    procurer: Procurer,
) -> FirmTask:
    durable_hires = [
        HireReceipt(
            agent_id=attempt.agent_id,
            name=attempt.agent_name,
            subtask=attempt.subtask,
            cost=attempt.cost,
            tx=attempt.tx,
            validation=attempt.validation,
        )
        for attempt in task.attempts
    ]
    durable_firings = [
        VendorFiring(
            agent_id=attempt.agent_id,
            subtask=attempt.subtask,
            reason=attempt.reason or "validation failed",
            cost_absorbed=attempt.cost,
        )
        for attempt in task.attempts
        if attempt.outcome == "fired"
    ]
    state: FirmGraphState = {
        "task": task,
        "vendors": vendors,
        "rejected": [],
        "fired": durable_firings,
        "hires": durable_hires,
        "store": store,
        "performance": performance,
        "procurer": procurer,
    }
    if task.state == JobState.REFUNDING:
        # A stale refund is a resumable money operation, not a new job. Starting
        # the graph at planning would source and pay vendors again while the
        # original buyer is still owed money.
        resumed = await refunding_node(state)
        if resumed["task"].state == JobState.REFUNDED:
            booking_node(resumed)
        return resumed["task"]
    # Drive the run through the compiled LangGraph. Nodes mutate the shared task
    # and checkpoint every transition to Postgres; the conditional edge out of
    # `validating` routes delivered jobs to assembly and failed ones to refund.
    result = await _graph().ainvoke(state)
    return result["task"]


async def run_one(
    settings: Settings,
    vendors: list[VendorIndexEntry] | None = None,
    procurer: Procurer | None = None,
) -> WorkerResult:
    store = PostgresCheckpointStore(settings.database_url)
    task = store.claim_next_task(stale_after_seconds=settings.worker_stale_after_seconds)
    if task is None:
        return WorkerResult(claimed=False)

    resolved_vendors = vendors if vendors is not None else load_vendor_index(Path(settings.vendor_index_path))
    performance = PostgresPerformanceStore(settings.database_url)
    resolved_procurer = procurer if procurer is not None else HttpProcurer(settings.procurer_url, auth_token=settings.procurer_auth_token)
    completed = await run_task(task, resolved_vendors, store, performance, resolved_procurer)
    return WorkerResult(claimed=True, task=completed)


async def run_task_by_id(
    settings: Settings,
    task_id: str,
    vendors: list[VendorIndexEntry] | None = None,
    procurer: Procurer | None = None,
) -> WorkerResult:
    store = PostgresCheckpointStore(settings.database_url)
    task = store.claim_task(task_id)
    if task is None:
        return WorkerResult(claimed=False)

    resolved_vendors = vendors if vendors is not None else load_vendor_index(Path(settings.vendor_index_path))
    performance = PostgresPerformanceStore(settings.database_url)
    resolved_procurer = procurer if procurer is not None else HttpProcurer(settings.procurer_url, auth_token=settings.procurer_auth_token)
    completed = await run_task(task, resolved_vendors, store, performance, resolved_procurer)
    return WorkerResult(claimed=True, task=completed)


def assert_stale_window_is_safe(settings: Settings) -> None:
    """Refuse to start a worker whose stale window can fire mid-job.

    `claim_next_task` reclaims any job whose `updated_at` is older than
    `worker_stale_after_seconds`, which is how a crashed worker's job gets
    picked up again. The safety of that depends entirely on a live worker
    bumping `updated_at` more often than the window: every `store.transition`
    does, so the real question is the longest gap between two transitions.

    That gap is one vendor call. If a single call can outlast the window, a
    worker that is merely slow looks identical to a dead one, a second worker
    claims the same job and restarts it from planning, and both hire vendors
    at once. The procurer's idempotency on (task_id, subtask_id,
    vendor_endpoint) absorbs most of that — the second worker replays rather
    than pays — but only while both workers walk the same candidate order.
    They need not: sourcing re-ranks against vendor_performance, which the
    first worker is concurrently mutating. Different order means a different
    vendor, a new idempotency key, and a genuine second payment.

    So this is a money-safety invariant, not a tidiness one, and it is a
    configuration mistake rather than a code path — which is exactly the kind
    worth failing loudly at startup instead of debugging from a double-spend.
    """
    # The procurer's own HTTP timeout is the ceiling on one call, plus the
    # worker's client-side margin. 3x is deliberate slack for a slow node.
    longest_node_seconds = 65
    if settings.worker_stale_after_seconds < longest_node_seconds * 3:
        raise ValueError(
            f"worker_stale_after_seconds={settings.worker_stale_after_seconds} is too small: a single "
            f"vendor call can take ~{longest_node_seconds}s, so a live worker would be treated as dead "
            f"and its job run twice. Set it to at least {longest_node_seconds * 3}."
        )


async def run_loop(settings: Settings, poll_seconds: float = 2.0) -> None:
    assert_stale_window_is_safe(settings)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signame in ("SIGINT", "SIGTERM"):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(getattr(signal, signame), stop.set)

    # Liveness is derived from this loop, not from the process: a hang is not an
    # exit, so a platform restart policy alone never notices. See health.py.
    heartbeat = Heartbeat(stale_after_seconds=settings.worker_stale_after_seconds)
    health_server = None
    if settings.worker_health_port:
        health_server = await serve_health(heartbeat, settings.worker_health_host, settings.worker_health_port)

    try:
        while not stop.is_set():
            heartbeat.tick()
            result = await run_one(settings)
            # Stamp again after the job: a long run should not read as a stall
            # the moment it finishes.
            heartbeat.tick(result.task.task_id if result.task else None)
            if not result.claimed:
                try:
                    await asyncio.wait_for(stop.wait(), timeout=poll_seconds)
                except TimeoutError:
                    pass
    finally:
        if health_server is not None:
            health_server.close()
            await health_server.wait_closed()
