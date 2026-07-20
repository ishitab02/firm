from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

from .models import ValidationFailure, ValidationResult

# A deliverable this short is almost certainly a stub or an error echoed back as
# content, not a real answer. Deterministic floor for the semantic check.
_MIN_MEANINGFUL_CHARS = 12


def _content_items(deliverable: dict[str, Any]) -> list[Any] | None:
    for key in ("observations", "checklist", "sections"):
        value = deliverable.get(key)
        if isinstance(value, list):
            return value
    return None


def validate(deliverable: dict[str, Any], subtask_spec: dict[str, Any]) -> ValidationResult:
    """Deterministic validation stack (INTERFACES §6).

    Pure and offline: schema, non-empty content, freshness, URL well-formedness
    where source_urls are present, and a deterministic semantic-sanity floor.
    Actual URL reachability and any LLM rubric live in check_liveness /
    semantic_rubric below, which the worker may run after these pass — they are
    kept out of here so this function stays pure and unit-testable.
    """
    checks_run = ["schema", "non_empty_content", "freshness", "semantic_sanity"]
    failures: list[ValidationFailure] = []

    if not isinstance(deliverable, dict):
        failures.append(ValidationFailure(check="schema", detail="deliverable is not an object"))
        return ValidationResult(passed=False, checks_run=checks_run, failures=failures)

    content = _content_items(deliverable)
    if content is None:
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
            generated = datetime.fromisoformat(str(generated_at).replace("Z", "+00:00"))
            age_seconds = (datetime.now(timezone.utc) - generated).total_seconds()
            if age_seconds > 3600:
                failures.append(
                    ValidationFailure(check="freshness", detail="generated_at is older than one hour")
                )
        except ValueError:
            failures.append(ValidationFailure(check="freshness", detail="generated_at is invalid"))
    else:
        failures.append(ValidationFailure(check="freshness", detail="generated_at is missing"))

    # URL well-formedness where applicable: a deliverable that cites sources must
    # cite real-looking http(s) URLs, not "example.invalid" or a bare word.
    source_urls = deliverable.get("source_urls")
    if source_urls is not None:
        checks_run.append("url_liveness")
        if not isinstance(source_urls, list) or not source_urls:
            failures.append(ValidationFailure(check="url_liveness", detail="source_urls must be a non-empty array"))
        else:
            for url in source_urls:
                parsed = urlparse(str(url))
                if parsed.scheme not in ("http", "https") or not parsed.netloc:
                    failures.append(
                        ValidationFailure(check="url_liveness", detail=f"malformed source url: {url}")
                    )
                    break

    # Deterministic semantic-sanity floor: the content must carry actual text,
    # not empty strings or a couple of characters. This runs before any LLM
    # rubric (INTERFACES §6: deterministic checks first, cheap LLM rubric last).
    acceptance = str(subtask_spec.get("acceptance", "")).strip()
    if content:
        text = " ".join(str(item) for item in content if isinstance(item, (str, int, float))).strip()
        if len(text) < _MIN_MEANINGFUL_CHARS:
            failures.append(
                ValidationFailure(
                    check="semantic_sanity",
                    detail="content is too short to be a meaningful deliverable",
                )
            )
    elif acceptance:
        failures.append(
            ValidationFailure(check="semantic_sanity", detail="no content to compare to acceptance criteria")
        )

    return ValidationResult(passed=len(failures) == 0, checks_run=checks_run, failures=failures)


async def check_liveness(deliverable: dict[str, Any], timeout_seconds: float = 5.0) -> ValidationResult:
    """Optional: actually reach the cited URLs. Kept separate from validate() so
    the deterministic stack stays pure and offline. The worker may run this after
    validate() passes when SOURCE_URL_LIVENESS is enabled.

    Not called by default. Never fabricates: a URL that cannot be reached fails
    with the transport error, it is not assumed live.
    """
    import httpx

    urls = deliverable.get("source_urls")
    checks_run = ["url_liveness_http"]
    if not isinstance(urls, list) or not urls:
        return ValidationResult(passed=True, checks_run=checks_run, failures=[])

    failures: list[ValidationFailure] = []
    async with httpx.AsyncClient(timeout=timeout_seconds, follow_redirects=True) as client:
        for url in urls:
            try:
                response = await client.head(str(url))
                if response.status_code >= 400:
                    failures.append(
                        ValidationFailure(check="url_liveness_http", detail=f"{url} returned HTTP {response.status_code}")
                    )
            except Exception as exc:  # network error, DNS failure, timeout
                failures.append(ValidationFailure(check="url_liveness_http", detail=f"{url} unreachable: {exc}"))

    return ValidationResult(passed=not failures, checks_run=checks_run, failures=failures)
