import argparse
import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

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
from .config import get_settings
from .models import (
    FirmTask,
    JobState,
    Money,
    PayAndCallRequest,
    PayAndCallResponse,
    Quote,
    VendorIndexEntry,
    VendorService,
)
from .sourcing import PerformanceStore
from .storage import InMemoryCheckpointStore, apply_migrations
from .storage import PostgresCheckpointStore, PostgresPerformanceStore
from .worker import run_loop, run_one, run_task_by_id


class DemoProcurer:
    async def pay_and_call(self, request: PayAndCallRequest) -> PayAndCallResponse:
        if "flaky" in request.vendor_endpoint:
            result = {
                "headline": "Stale launch brief",
                "generated_at": "2026-07-10T12:00:00Z",
            }
        else:
            result = {
                "kind": "launch_brief",
                "checklist": [
                    "Confirm chain and token standard.",
                    "Publish launch messaging.",
                    "Prepare liquidity and monitoring steps.",
                ],
                "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            }

        return PayAndCallResponse(
            ok=True,
            result=result,
            receipt={
                "amount": request.max_amount.model_dump(),
                "tx": f"SIMULATED:{request.vendor_endpoint.rsplit('/', maxsplit=1)[-1]}",
                "payment_response": "SIMULATED demo procurer call",
            },
            latency_ms=50,
        )

    async def refund(self, task_id: str, to_address: str, amount: dict[str, object]) -> dict[str, str]:
        return {"tx": f"SIMULATED:refund:{task_id}"}


def main() -> None:
    parser = argparse.ArgumentParser(prog="firm-worker")
    parser.add_argument(
        "command",
        choices=[
            "demo",
            "migrate",
            "smoke-postgres",
            "work-once",
            "work-once-demo",
            "work-task-demo",
            "work-task",
            "run",
            "smoke-worker",
            "smoke-refund",
            "status",
            "result",
        ],
    )
    parser.add_argument("task_id", nargs="?")
    parser.add_argument("--poll-seconds", type=float, default=2.0)
    args = parser.parse_args()
    if args.command == "demo":
        asyncio.run(run_demo())
    elif args.command == "migrate":
        settings = get_settings()
        apply_migrations(settings.database_url, settings_path_migrations_dir())
    elif args.command == "smoke-postgres":
        run_postgres_smoke()
    elif args.command == "work-once":
        asyncio.run(run_work_once())
    elif args.command == "work-once-demo":
        asyncio.run(run_work_once_demo())
    elif args.command == "work-task-demo":
        if not args.task_id:
            parser.error("work-task-demo requires task_id")
        asyncio.run(run_work_task_demo(args.task_id))
    elif args.command == "work-task":
        if not args.task_id:
            parser.error("work-task requires task_id")
        asyncio.run(run_work_task(args.task_id))
    elif args.command == "run":
        asyncio.run(run_loop(get_settings(), poll_seconds=args.poll_seconds))
    elif args.command == "smoke-worker":
        asyncio.run(run_worker_smoke())
    elif args.command == "smoke-refund":
        asyncio.run(run_refund_smoke())
    elif args.command == "status":
        if not args.task_id:
            parser.error("status requires task_id")
        print_status(args.task_id)
    elif args.command == "result":
        if not args.task_id:
            parser.error("result requires task_id")
        print_result(args.task_id)


def settings_path_migrations_dir():
    return Path(__file__).resolve().parents[2] / "migrations"


def print_status(task_id: str) -> None:
    settings = get_settings()
    status = PostgresCheckpointStore(settings.database_url).get_status(task_id)
    print(json.dumps(status.model_dump(mode="json") if status else {"error": {"code": "NOT_FOUND"}}, indent=2))


def print_result(task_id: str) -> None:
    settings = get_settings()
    result = PostgresCheckpointStore(settings.database_url).get_result_payload(task_id)
    print(json.dumps(result, indent=2))


def run_postgres_smoke() -> None:
    settings = get_settings()
    apply_migrations(settings.database_url, settings_path_migrations_dir())

    quote = Quote(
        quote_id="q_pg_smoke",
        price=Money.usdt(600_000),
        plan_summary=[{"subtask": "launch brief", "capability": "token_launch"}],
        valid_until=datetime.now(timezone.utc),
        pricing_mode="QUOTED_AMOUNT",
    )
    task = FirmTask(task_id="t_pg_smoke", goal="Verify live Postgres persistence", quote=quote)

    checkpoints = PostgresCheckpointStore(settings.database_url)
    checkpoints.transition(task, JobState.PLANNING, "postgres smoke planning checkpoint")
    checkpoints.transition(task, JobState.SOURCING, "postgres smoke sourcing checkpoint")
    restored = checkpoints.get_task(task.task_id)

    performance = PostgresPerformanceStore(settings.database_url)
    record = performance.record_validation_failure("mock-flaky-001")

    print(
        json.dumps(
            {
                "ok": restored is not None and restored.state == JobState.SOURCING,
                "task_id": restored.task_id if restored else None,
                "state": restored.state.value if restored else None,
                "progress_count": len(restored.progress) if restored else 0,
                "vendor_performance": record.model_dump(mode="json"),
            },
            indent=2,
        )
    )


async def run_work_once() -> None:
    settings = get_settings()
    result = await run_one(settings)
    print(
        json.dumps(
            {
                "claimed": result.claimed,
                "task_id": result.task.task_id if result.task else None,
                "state": result.task.state.value if result.task else None,
            },
            indent=2,
        )
    )


async def run_work_once_demo() -> None:
    settings = get_settings()
    result = await run_one(settings, vendors=demo_vendors(prefix="gateway-demo"), procurer=DemoProcurer())
    print(
        json.dumps(
            {
                "claimed": result.claimed,
                "task_id": result.task.task_id if result.task else None,
                "state": result.task.state.value if result.task else None,
                "result_ready": result.task.deliverable is not None if result.task else False,
            },
            indent=2,
        )
    )


async def run_work_task_demo(task_id: str) -> None:
    settings = get_settings()
    result = await run_task_by_id(
        settings,
        task_id,
        vendors=demo_vendors(prefix=f"gateway-demo-{task_id}"),
        procurer=DemoProcurer(),
    )
    print(
        json.dumps(
            {
                "claimed": result.claimed,
                "task_id": result.task.task_id if result.task else None,
                "state": result.task.state.value if result.task else None,
                "result_ready": result.task.deliverable is not None if result.task else False,
            },
            indent=2,
        )
    )


async def run_work_task(task_id: str) -> None:
    settings = get_settings()
    from .worker import run_task_by_id

    result = await run_task_by_id(settings, task_id)
    print(
        json.dumps(
            {
                "claimed": result.claimed,
                "task_id": result.task.task_id if result.task else None,
                "state": result.task.state.value if result.task else None,
                "result_ready": result.task.deliverable is not None if result.task else False,
            },
            indent=2,
        )
    )


async def run_worker_smoke() -> None:
    settings = get_settings()
    apply_migrations(settings.database_url, settings_path_migrations_dir())
    run_id = uuid4().hex[:8]
    store = PostgresCheckpointStore(settings.database_url)
    task = FirmTask(
        task_id=f"t_worker_smoke_{run_id}",
        goal="Prepare a launch and market briefing",
        quote=Quote(
            quote_id=f"q_worker_smoke_{run_id}",
            price=Money.usdt(600_000),
            plan_summary=[{"subtask": "launch brief", "capability": "token_launch"}],
            valid_until=datetime.now(timezone.utc),
            pricing_mode="QUOTED_AMOUNT",
        ),
        state=JobState.PAID,
    )
    store.save_task(task)
    result = await run_task_by_id(
        settings,
        task.task_id,
        vendors=demo_vendors(prefix=f"smoke-{run_id}"),
        procurer=DemoProcurer(),
    )
    restored = store.get_task(task.task_id)
    status = store.get_status(task.task_id)
    result_payload = store.get_result(task.task_id)
    print(
        json.dumps(
            {
                "claimed": result.claimed,
                "task_id": restored.task_id if restored else None,
                "state": restored.state.value if restored else None,
                "status_state": status.state if status else None,
                "progress_count": len(restored.progress) if restored else 0,
                "result_ready": result_payload is not None,
                "vendors_fired": [
                    firing.model_dump(mode="json") for firing in restored.provenance.vendors_fired
                ]
                if restored and restored.provenance
                else [],
                "guarantee_status": restored.provenance.guarantee_status
                if restored and restored.provenance
                else None,
            },
            indent=2,
        )
    )


async def run_refund_smoke() -> None:
    settings = get_settings()
    apply_migrations(settings.database_url, settings_path_migrations_dir())
    run_id = uuid4().hex[:8]
    store = PostgresCheckpointStore(settings.database_url)
    task = FirmTask(
        task_id=f"t_refund_smoke_{run_id}",
        goal="Prepare a launch and market briefing",
        quote=Quote(
            quote_id=f"q_refund_smoke_{run_id}",
            price=Money.usdt(600_000),
            plan_summary=[{"subtask": "launch brief", "capability": "token_launch"}],
            valid_until=datetime.now(timezone.utc),
            pricing_mode="QUOTED_AMOUNT",
        ),
        state=JobState.PAID,
    )
    store.save_task(task)
    result = await run_task_by_id(
        settings,
        task.task_id,
        vendors=[demo_vendors(prefix=f"refund-{run_id}")[0]],
        procurer=DemoProcurer(),
    )
    restored = store.get_task(task.task_id)
    print(
        json.dumps(
            {
                "claimed": result.claimed,
                "task_id": restored.task_id if restored else None,
                "state": restored.state.value if restored else None,
                "refund": restored.refund if restored else None,
                "guarantee_status": restored.provenance.guarantee_status
                if restored and restored.provenance
                else None,
                "result_ready": store.get_result(task.task_id) is not None,
            },
            indent=2,
        )
    )


async def run_demo() -> None:
    quote = Quote(
        quote_id="q_demo",
        price=Money.usdt(600_000),
        plan_summary=[{"subtask": "launch brief", "capability": "token_launch"}],
        valid_until=datetime.now(timezone.utc),
        pricing_mode="QUOTED_AMOUNT",
    )
    task = FirmTask(task_id="t_demo", goal="Prepare a launch and market briefing", quote=quote)
    vendors = demo_vendors()
    state: FirmGraphState = {
        "task": task,
        "vendors": vendors,
        "rejected": [],
        "fired": [],
        "hires": [],
        "store": InMemoryCheckpointStore(),
        "performance": PerformanceStore({}),
        "procurer": DemoProcurer(),
    }
    state = planning_node(state)
    state = sourcing_node(state)
    state = vetting_node(state)
    state = await procuring_node(state)
    state = validating_node(state)
    state = assembling_node(state)
    state = booking_node(state)
    print(json.dumps(state["task"].model_dump(mode="json"), indent=2))


def demo_vendors(prefix: str = "mock") -> list[VendorIndexEntry]:
    return [
        VendorIndexEntry(
            agent_id=f"{prefix}-flaky-001",
            name="Firm Mock Flaky Vendor",
            endpoint="http://mock.local/flaky",
            services=[
                VendorService(
                    tool="launch_brief",
                    capability="token_launch",
                    price=Money.usdt(300_000),
                )
            ],
            kya_base_score=90,
            flags=[],
            last_verified_at="2026-07-18T00:00:00Z",
        ),
        VendorIndexEntry(
            agent_id=f"{prefix}-good-001",
            name="Firm Mock Reliable Vendor",
            endpoint="http://mock.local/good",
            services=[
                VendorService(
                    tool="launch_brief",
                    capability="token_launch",
                    price=Money.usdt(350_000),
                )
            ],
            kya_base_score=86,
            flags=[],
            last_verified_at="2026-07-18T00:00:00Z",
        )
    ]


if __name__ == "__main__":
    main()
