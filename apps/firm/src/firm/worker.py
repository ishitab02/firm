import asyncio
import contextlib
import signal
from dataclasses import dataclass
from pathlib import Path

from .config import Settings
from .graph import (
    FirmGraphState,
    assembling_node,
    booking_node,
    planning_node,
    procuring_node,
    sourcing_node,
    validating_node,
    vetting_node,
)
from .graph import refunding_node
from .models import FirmTask, VendorIndexEntry
from .procurer import HttpProcurer, Procurer
from .sourcing import load_vendor_index
from .storage import PostgresCheckpointStore, PostgresPerformanceStore


@dataclass
class WorkerResult:
    claimed: bool
    task: FirmTask | None = None


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
    state = planning_node(state)
    state = sourcing_node(state)
    state = vetting_node(state)
    state = await procuring_node(state)
    state = validating_node(state)
    state = await refunding_node(state)
    state = assembling_node(state)
    state = booking_node(state)
    return state["task"]


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
