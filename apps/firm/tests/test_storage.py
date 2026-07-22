from datetime import datetime, timezone

from firm.models import FirmTask, JobState, Money, Quote, VendorPerformance
from firm.models import BooksReceipt, Economics, ProvenanceReceipt
from firm.storage import PostgresCheckpointStore, PostgresPerformanceStore


class FakeCursor:
    def __init__(self, database):
        self.database = database
        self.result = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        if normalized.startswith("INSERT INTO firm_jobs"):
            (
                task_id,
                quote_id,
                state,
                goal,
                quote,
                job_params,
                progress,
                deliverable,
                provenance,
                refund,
                attempts,
            ) = params[:11]
            self.database["firm_jobs"][task_id] = {
                "task_id": task_id,
                "quote_id": quote_id,
                "state": state,
                "goal": goal,
                "quote": unwrap_jsonb(quote),
                "params": unwrap_jsonb(job_params),
                "progress": unwrap_jsonb(progress),
                "deliverable": unwrap_jsonb(deliverable),
                "provenance": unwrap_jsonb(provenance),
                "refund": unwrap_jsonb(refund),
                "attempts": unwrap_jsonb(attempts),
                "updated_at_is_stale": self.database.get("force_stale", False),
            }
        elif normalized.startswith("INSERT INTO firm_job_checkpoints"):
            task_id, state, subtask_id, note, created_at = params
            self.database["firm_job_checkpoints"].append(
                {
                    "task_id": task_id,
                    "state": state,
                    "subtask_id": subtask_id,
                    "note": note,
                    "created_at": created_at,
                }
            )
        elif normalized.startswith("WITH next_job AS"):
            states, stale_states, _stale_after_seconds, refunding_state, resume_state, claimed_state = params
            claimable = [
                row
                for row in self.database["firm_jobs"].values()
                if row["state"] in set(states)
                or (row["state"] in set(stale_states) and row.get("updated_at_is_stale", False))
            ]
            if not claimable:
                self.result = None
                return
            row = claimable[0]
            row["state"] = resume_state if row["state"] == refunding_state else claimed_state
            self.result = row
        elif normalized.startswith("UPDATE firm_jobs SET state = CASE"):
            refunding_state, resume_state, claimed_state, task_id, *allowed_states = params
            row = self.database["firm_jobs"].get(task_id)
            if row is None or row["state"] not in set(allowed_states):
                self.result = None
                return
            row["state"] = resume_state if row["state"] == refunding_state else claimed_state
            self.result = row
        elif "FROM firm_jobs" in normalized:
            row = self.database["firm_jobs"].get(params[0])
            if row is None:
                self.result = None
            elif normalized.startswith("SELECT state, progress"):
                self.result = {"state": row["state"], "progress": row["progress"]}
            elif normalized.startswith("SELECT deliverable, provenance"):
                if row["state"] == "complete" and row["deliverable"] and row["provenance"]:
                    self.result = {
                        "deliverable": row["deliverable"],
                        "provenance": row["provenance"],
                    }
                else:
                    self.result = None
            else:
                self.result = row
        elif normalized.startswith("SELECT agent_id"):
            self.result = list(self.database["vendor_performance"].values())
        elif normalized.startswith("INSERT INTO vendor_performance"):
            (
                agent_id,
                calls,
                successes,
                validation_failures,
                timeouts,
                last_failure_at,
                adjustment,
            ) = params
            self.database["vendor_performance"][agent_id] = {
                "agent_id": agent_id,
                "calls": calls,
                "successes": successes,
                "validation_failures": validation_failures,
                "timeouts": timeouts,
                "last_failure_at": last_failure_at,
                "adjustment": adjustment,
            }
        else:
            raise AssertionError(f"Unexpected SQL: {normalized}")

    def fetchone(self):
        return self.result

    def fetchall(self):
        return self.result


class FakeConnection:
    def __init__(self, database):
        self.database = database

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def cursor(self):
        return FakeCursor(self.database)


def unwrap_jsonb(value):
    return getattr(value, "obj", value)


def patch_connect(monkeypatch, database):
    def fake_connect(*args, **kwargs):
        return FakeConnection(database)

    monkeypatch.setattr("firm.storage.psycopg.connect", fake_connect)


def quote() -> Quote:
    return Quote(
        quote_id="q_test",
        price=Money.usdt(600_000),
        plan_summary=[{"subtask": "launch brief", "capability": "token_launch"}],
        valid_until=datetime.now(timezone.utc),
    )


def test_postgres_checkpoint_store_saves_task_and_appends_checkpoint(monkeypatch) -> None:
    database = {"firm_jobs": {}, "firm_job_checkpoints": [], "vendor_performance": {}}
    patch_connect(monkeypatch, database)
    store = PostgresCheckpointStore("postgresql://test")
    task = FirmTask(task_id="t_test", goal="ship firm", quote=quote())

    store.transition(task, JobState.SOURCING, "ranked vendors")
    restored = store.get_task("t_test")

    assert restored is not None
    assert restored.state == JobState.SOURCING
    assert restored.progress[0].note == "ranked vendors"
    assert database["firm_job_checkpoints"][0]["state"] == "sourcing"


def test_postgres_checkpoint_store_claims_next_paid_task(monkeypatch) -> None:
    database = {"firm_jobs": {}, "firm_job_checkpoints": [], "vendor_performance": {}}
    patch_connect(monkeypatch, database)
    store = PostgresCheckpointStore("postgresql://test")
    task = FirmTask(task_id="t_claim", goal="ship firm", quote=quote(), state=JobState.PAID)
    store.save_task(task)

    claimed = store.claim_next_task()

    assert claimed is not None
    assert claimed.task_id == "t_claim"
    assert claimed.state == JobState.PLANNING


def test_postgres_checkpoint_store_does_not_claim_fresh_in_progress_task(monkeypatch) -> None:
    database = {"firm_jobs": {}, "firm_job_checkpoints": [], "vendor_performance": {}}
    patch_connect(monkeypatch, database)
    store = PostgresCheckpointStore("postgresql://test")
    task = FirmTask(task_id="t_fresh", goal="ship firm", quote=quote(), state=JobState.PROCURING)
    store.save_task(task)

    assert store.claim_next_task() is None


def test_postgres_checkpoint_store_reclaims_stale_in_progress_task(monkeypatch) -> None:
    database = {"firm_jobs": {}, "firm_job_checkpoints": [], "vendor_performance": {}, "force_stale": True}
    patch_connect(monkeypatch, database)
    store = PostgresCheckpointStore("postgresql://test")
    task = FirmTask(task_id="t_stale", goal="ship firm", quote=quote(), state=JobState.PROCURING)
    store.save_task(task)

    claimed = store.claim_next_task()

    assert claimed is not None
    assert claimed.task_id == "t_stale"
    assert claimed.state == JobState.PLANNING


def test_postgres_checkpoint_store_resumes_stale_refund_without_replanning(monkeypatch) -> None:
    database = {"firm_jobs": {}, "firm_job_checkpoints": [], "vendor_performance": {}, "force_stale": True}
    patch_connect(monkeypatch, database)
    store = PostgresCheckpointStore("postgresql://test")
    task = FirmTask(task_id="t_refund_resume", goal="ship firm", quote=quote(), state=JobState.REFUNDING)
    store.save_task(task)

    claimed = store.claim_next_task()

    assert claimed is not None
    assert claimed.state == JobState.REFUNDING


def test_postgres_checkpoint_store_claims_specific_task(monkeypatch) -> None:
    database = {"firm_jobs": {}, "firm_job_checkpoints": [], "vendor_performance": {}}
    patch_connect(monkeypatch, database)
    store = PostgresCheckpointStore("postgresql://test")
    store.save_task(FirmTask(task_id="t_one", goal="ship one", quote=quote(), state=JobState.PAID))
    store.save_task(FirmTask(task_id="t_two", goal="ship two", quote=quote(), state=JobState.PAID))

    claimed = store.claim_task("t_two")

    assert claimed is not None
    assert claimed.task_id == "t_two"
    assert database["firm_jobs"]["t_one"]["state"] == "paid"


def test_postgres_checkpoint_store_reads_status(monkeypatch) -> None:
    database = {"firm_jobs": {}, "firm_job_checkpoints": [], "vendor_performance": {}}
    patch_connect(monkeypatch, database)
    store = PostgresCheckpointStore("postgresql://test")
    task = FirmTask(task_id="t_status", goal="ship firm", quote=quote())
    store.transition(task, JobState.SOURCING, "ranked vendors")

    status = store.get_status("t_status")

    assert status is not None
    assert status.state == "sourcing"
    assert status.progress[0].note == "ranked vendors"


def test_postgres_checkpoint_store_reads_complete_result_only(monkeypatch) -> None:
    database = {"firm_jobs": {}, "firm_job_checkpoints": [], "vendor_performance": {}}
    patch_connect(monkeypatch, database)
    store = PostgresCheckpointStore("postgresql://test")
    task = FirmTask(task_id="t_result", goal="ship firm", quote=quote())

    assert store.get_result("t_result") is None

    task.deliverable = {"summary": "done"}
    task.provenance = ProvenanceReceipt(
        task_id=task.task_id,
        goal=task.goal,
        quote={"price": task.quote.price.model_dump(), "quoted_at": task.quote.quoted_at.isoformat()},
        vendors_vetted=1,
        vendors_rejected=[],
        vendors_fired=[],
        hires=[],
        economics=Economics(
            user_price=task.quote.price,
            actual_vendor_costs=Money.usdt(0),
            margin_retained_or_absorbed={"amount": "600000", "sign": "retained"},
        ),
        books=BooksReceipt(
            cost=Money.usdt(50_000),
            tx="SIMULATED:books",
            statement="SIMULATED books statement",
        ),
        guarantee_status="delivered",
    )
    store.transition(task, JobState.COMPLETE, "done")

    result = store.get_result("t_result")

    assert result is not None
    assert result.deliverable == {"summary": "done"}
    assert result.provenance.guarantee_status == "delivered"


def test_postgres_checkpoint_store_result_payload_exposes_refund_audit(monkeypatch) -> None:
    database = {"firm_jobs": {}, "firm_job_checkpoints": [], "vendor_performance": {}}
    patch_connect(monkeypatch, database)
    store = PostgresCheckpointStore("postgresql://test")
    task = FirmTask(task_id="t_refunded", goal="ship firm", quote=quote(), state=JobState.PAID)
    task.refund = {"tx": "SIMULATED:refund:t_refunded"}
    task.provenance = ProvenanceReceipt(
        task_id=task.task_id,
        goal=task.goal,
        quote={"price": task.quote.price.model_dump(), "quoted_at": task.quote.quoted_at.isoformat()},
        vendors_vetted=1,
        vendors_rejected=[],
        vendors_fired=[],
        hires=[],
        economics=Economics(
            user_price=task.quote.price,
            actual_vendor_costs=Money.usdt(0),
            margin_retained_or_absorbed={"amount": "600000", "sign": "retained"},
        ),
        books=BooksReceipt(
            cost=Money.usdt(50_000),
            tx="SIMULATED:books",
            statement="SIMULATED books statement",
        ),
        guarantee_status="refunded",
    )
    store.transition(task, JobState.FAILED_REFUNDED, "refund issued")

    payload = store.get_result_payload("t_refunded")

    assert payload["error"]["code"] == "REFUNDED"
    assert payload["error"]["refund"]["tx"] == "SIMULATED:refund:t_refunded"


def test_postgres_performance_store_loads_and_persists_adjustment(monkeypatch) -> None:
    database = {
        "firm_jobs": {},
        "firm_job_checkpoints": [],
        "vendor_performance": {
            "mock-flaky-001": VendorPerformance(agent_id="mock-flaky-001").model_dump()
        },
    }
    patch_connect(monkeypatch, database)
    store = PostgresPerformanceStore("postgresql://test")

    record = store.record_validation_failure("mock-flaky-001")

    assert record.calls == 1
    assert record.validation_failures == 1
    assert record.adjustment == -10
    assert database["vendor_performance"]["mock-flaky-001"]["adjustment"] == -10
