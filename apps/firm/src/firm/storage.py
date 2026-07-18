from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .models import FirmTask, JobState, ProgressItem, ResultResponse, StatusResponse, VendorPerformance


class CheckpointStore(Protocol):
    def save_task(self, task: FirmTask) -> None: ...

    def get_task(self, task_id: str) -> FirmTask | None: ...

    def get_status(self, task_id: str) -> StatusResponse | None: ...

    def get_result(self, task_id: str) -> ResultResponse | None: ...

    def transition(self, task: FirmTask, state: JobState, note: str, subtask_id: str = "task") -> None: ...


def apply_migrations(database_url: str, migrations_dir: Path) -> None:
    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            for migration in sorted(migrations_dir.glob("*.sql")):
                cursor.execute(migration.read_text(encoding="utf-8"))


@dataclass
class InMemoryCheckpointStore:
    tasks: dict[str, FirmTask] = field(default_factory=dict)
    vendor_performance: dict[str, VendorPerformance] = field(default_factory=dict)

    def save_task(self, task: FirmTask) -> None:
        self.tasks[task.task_id] = task

    def get_task(self, task_id: str) -> FirmTask | None:
        return self.tasks.get(task_id)

    def get_status(self, task_id: str) -> StatusResponse | None:
        task = self.get_task(task_id)
        if task is None:
            return None
        return StatusResponse(state=task.state.value, progress=task.progress)

    def get_result(self, task_id: str) -> ResultResponse | None:
        task = self.get_task(task_id)
        if task is None or task.state != JobState.COMPLETE or task.deliverable is None or task.provenance is None:
            return None
        return ResultResponse(deliverable=task.deliverable, provenance=task.provenance)

    def get_result_payload(self, task_id: str) -> dict[str, object]:
        task = self.get_task(task_id)
        if task is None:
            return {"error": {"code": "NOT_FOUND"}}
        if task.state == JobState.FAILED_REFUNDED and task.provenance is not None:
            return {
                "error": {
                    "code": "REFUNDED",
                    "refund": task.refund,
                    "provenance": task.provenance.model_dump(mode="json"),
                }
            }
        result = self.get_result(task_id)
        if result is None:
            return {"error": {"code": "NOT_READY_OR_NOT_FOUND"}}
        return result.model_dump(mode="json")

    def transition(self, task: FirmTask, state: JobState, note: str, subtask_id: str = "task") -> None:
        task.state = state
        task.progress.append(
            ProgressItem(
                subtask_id=subtask_id,
                state=state.value,
                note=note,
                timestamp=datetime.now(timezone.utc),
            )
        )
        self.save_task(task)

    def all_performance(self) -> Iterable[VendorPerformance]:
        return self.vendor_performance.values()


class PostgresCheckpointStore:
    def __init__(self, database_url: str) -> None:
        self.database_url = database_url

    def save_task(self, task: FirmTask) -> None:
        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                self._save_task(cursor, task)

    def get_task(self, task_id: str) -> FirmTask | None:
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT task_id, goal, quote, state, progress, deliverable, provenance, refund
                    FROM firm_jobs
                    WHERE task_id = %s
                    """,
                    (task_id,),
                )
                row = cursor.fetchone()
        if row is None:
            return None
        return FirmTask.model_validate(row)

    def get_status(self, task_id: str) -> StatusResponse | None:
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT state, progress
                    FROM firm_jobs
                    WHERE task_id = %s
                    """,
                    (task_id,),
                )
                row = cursor.fetchone()
        if row is None:
            return None
        return StatusResponse.model_validate(row)

    def get_result(self, task_id: str) -> ResultResponse | None:
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT deliverable, provenance
                    FROM firm_jobs
                    WHERE task_id = %s
                      AND state = %s
                      AND deliverable IS NOT NULL
                      AND provenance IS NOT NULL
                    """,
                    (task_id, JobState.COMPLETE.value),
                )
                row = cursor.fetchone()
        if row is None:
            return None
        return ResultResponse.model_validate(row)

    def get_result_payload(self, task_id: str) -> dict[str, object]:
        task = self.get_task(task_id)
        if task is None:
            return {"error": {"code": "NOT_FOUND"}}
        if task.state == JobState.FAILED_REFUNDED and task.provenance is not None:
            return {
                "error": {
                    "code": "REFUNDED",
                    "refund": task.refund,
                    "provenance": task.provenance.model_dump(mode="json"),
                }
            }
        result = self.get_result(task_id)
        if result is None:
            return {"error": {"code": "NOT_READY_OR_NOT_FOUND"}}
        return result.model_dump(mode="json")

    def claim_next_task(
        self,
        claimable_states: tuple[JobState, ...] = (JobState.PAID,),
        stale_states: tuple[JobState, ...] = (
            JobState.PLANNING,
            JobState.SOURCING,
            JobState.VETTING,
            JobState.PROCURING,
            JobState.VALIDATING,
            JobState.ASSEMBLING,
            JobState.BOOKING,
            JobState.REFUNDING,
        ),
        stale_after_seconds: int = 300,
    ) -> FirmTask | None:
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    WITH next_job AS (
                      SELECT task_id
                      FROM firm_jobs
                      WHERE state = ANY(%s)
                         OR (
                           state = ANY(%s)
                           AND updated_at < now() - make_interval(secs => %s)
                         )
                      ORDER BY created_at ASC
                      FOR UPDATE SKIP LOCKED
                      LIMIT 1
                    )
                    UPDATE firm_jobs
                    SET state = %s, updated_at = now()
                    FROM next_job
                    WHERE firm_jobs.task_id = next_job.task_id
                    RETURNING firm_jobs.task_id, firm_jobs.goal, firm_jobs.quote,
                              firm_jobs.state, firm_jobs.progress,
                              firm_jobs.deliverable, firm_jobs.provenance, firm_jobs.refund
                    """,
                    (
                        [state.value for state in claimable_states],
                        [state.value for state in stale_states],
                        stale_after_seconds,
                        JobState.PLANNING.value,
                    ),
                )
                row = cursor.fetchone()
        if row is None:
            return None
        return FirmTask.model_validate(row)

    def claim_task(self, task_id: str) -> FirmTask | None:
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE firm_jobs
                    SET state = %s, updated_at = now()
                    WHERE task_id = %s
                      AND state IN (%s, %s)
                    RETURNING task_id, goal, quote, state, progress,
                              deliverable, provenance, refund
                    """,
                    (JobState.PLANNING.value, task_id, JobState.PAID.value, JobState.PLANNING.value),
                )
                row = cursor.fetchone()
        if row is None:
            return None
        return FirmTask.model_validate(row)

    def transition(self, task: FirmTask, state: JobState, note: str, subtask_id: str = "task") -> None:
        progress = ProgressItem(
            subtask_id=subtask_id,
            state=state.value,
            note=note,
            timestamp=datetime.now(timezone.utc),
        )
        task.state = state
        task.progress.append(progress)

        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                self._save_task(cursor, task)
                cursor.execute(
                    """
                    INSERT INTO firm_job_checkpoints (task_id, state, subtask_id, note, created_at)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (task.task_id, state.value, subtask_id, note, progress.timestamp),
                )

    def _save_task(self, cursor: psycopg.Cursor, task: FirmTask) -> None:
        cursor.execute(
            """
            INSERT INTO firm_jobs (
              task_id, quote_id, state, goal, quote, progress, deliverable, provenance, refund, updated_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (task_id) DO UPDATE SET
              state = EXCLUDED.state,
              goal = EXCLUDED.goal,
              quote = EXCLUDED.quote,
              progress = EXCLUDED.progress,
              deliverable = EXCLUDED.deliverable,
              provenance = EXCLUDED.provenance,
              refund = EXCLUDED.refund,
              updated_at = now()
            """,
            (
                task.task_id,
                task.quote.quote_id,
                task.state.value,
                task.goal,
                Jsonb(task.quote.model_dump(mode="json")),
                Jsonb([item.model_dump(mode="json") for item in task.progress]),
                Jsonb(task.deliverable),
                Jsonb(task.provenance.model_dump(mode="json") if task.provenance else None),
                Jsonb(task.refund),
            ),
        )


class PostgresPerformanceStore:
    def __init__(self, database_url: str) -> None:
        self.database_url = database_url
        self.records = self._load_records()

    def get(self, agent_id: str) -> VendorPerformance:
        record = self.records.get(agent_id)
        if record is not None:
            return record

        record = VendorPerformance(agent_id=agent_id)
        self.records[agent_id] = record
        self._upsert(record)
        return record

    def all_performance(self) -> Iterable[VendorPerformance]:
        return self.records.values()

    def record_success(self, agent_id: str) -> VendorPerformance:
        record = self.get(agent_id)
        record.calls += 1
        record.successes += 1
        record.adjustment = min(record.adjustment + 1, 10)
        self._upsert(record)
        return record

    def record_validation_failure(self, agent_id: str) -> VendorPerformance:
        record = self.get(agent_id)
        record.calls += 1
        record.validation_failures += 1
        record.last_failure_at = datetime.now(timezone.utc)
        record.adjustment = max(record.adjustment - 10, -30)
        self._upsert(record)
        return record

    def record_timeout(self, agent_id: str) -> VendorPerformance:
        record = self.get(agent_id)
        record.calls += 1
        record.timeouts += 1
        record.last_failure_at = datetime.now(timezone.utc)
        record.adjustment = max(record.adjustment - 10, -30)
        self._upsert(record)
        return record

    def _load_records(self) -> dict[str, VendorPerformance]:
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT agent_id, calls, successes, validation_failures, timeouts,
                           last_failure_at, adjustment
                    FROM vendor_performance
                    """
                )
                rows = cursor.fetchall()
        return {row["agent_id"]: VendorPerformance.model_validate(row) for row in rows}

    def _upsert(self, record: VendorPerformance) -> None:
        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO vendor_performance (
                      agent_id, calls, successes, validation_failures, timeouts,
                      last_failure_at, adjustment
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (agent_id) DO UPDATE SET
                      calls = EXCLUDED.calls,
                      successes = EXCLUDED.successes,
                      validation_failures = EXCLUDED.validation_failures,
                      timeouts = EXCLUDED.timeouts,
                      last_failure_at = EXCLUDED.last_failure_at,
                      adjustment = EXCLUDED.adjustment
                    """,
                    (
                        record.agent_id,
                        record.calls,
                        record.successes,
                        record.validation_failures,
                        record.timeouts,
                        record.last_failure_at,
                        record.adjustment,
                    ),
                )
