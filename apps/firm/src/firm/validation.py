from datetime import datetime, timezone
from typing import Any

from .models import ValidationFailure, ValidationResult


def validate(deliverable: dict[str, Any], subtask_spec: dict[str, Any]) -> ValidationResult:
    checks_run = ["schema", "non_empty_content", "freshness", "semantic_sanity"]
    failures: list[ValidationFailure] = []

    if not isinstance(deliverable, dict):
        failures.append(ValidationFailure(check="schema", detail="deliverable is not an object"))
        return ValidationResult(passed=False, checks_run=checks_run, failures=failures)

    content = deliverable.get("observations") or deliverable.get("checklist") or deliverable.get("sections")
    if not isinstance(content, list):
        failures.append(
            ValidationFailure(
                check="schema",
                detail="deliverable must include observations, checklist, or sections array",
            )
        )
    elif len(content) == 0:
        failures.append(ValidationFailure(check="non_empty_content", detail="content is empty"))

    generated_at = deliverable.get("generated_at")
    if generated_at:
        try:
            generated = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
            age_seconds = (datetime.now(timezone.utc) - generated).total_seconds()
            if age_seconds > 3600:
                failures.append(
                    ValidationFailure(check="freshness", detail="generated_at is older than one hour")
                )
        except ValueError:
            failures.append(ValidationFailure(check="freshness", detail="generated_at is invalid"))
    else:
        failures.append(ValidationFailure(check="freshness", detail="generated_at is missing"))

    acceptance = str(subtask_spec.get("acceptance", "")).strip()
    if acceptance and not content:
        failures.append(
            ValidationFailure(check="semantic_sanity", detail="no content to compare to acceptance criteria")
        )

    return ValidationResult(passed=len(failures) == 0, checks_run=checks_run, failures=failures)
