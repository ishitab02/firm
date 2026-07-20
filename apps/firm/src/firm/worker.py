import asyncio
import contextlib
import signal
from dataclasses import dataclass
from pathlib import Path

from .config import Settings
from .graph import FirmGraphState, build_graph
from .models import FirmTask, VendorIndexEntry
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
    state: FirmGraphState = {
        "task": task,
        "vendors": vendors,
        "rejected": [],
        "fired": [],
        "hires": [],
        "store": store,
        "performance": performance,
        "procurer": procurer,
    }
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
    resolved_procurer = procurer if procurer is not None else HttpProcurer(settings.procurer_url)
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
    resolved_procurer = procurer if procurer is not None else HttpProcurer(settings.procurer_url)
    completed = await run_task(task, resolved_vendors, store, performance, resolved_procurer)
    return WorkerResult(claimed=True, task=completed)


async def run_loop(settings: Settings, poll_seconds: float = 2.0) -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signame in ("SIGINT", "SIGTERM"):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(getattr(signal, signame), stop.set)

    while not stop.is_set():
        result = await run_one(settings)
        if not result.claimed:
            try:
                await asyncio.wait_for(stop.wait(), timeout=poll_seconds)
            except TimeoutError:
                pass
