from firm.validation import validate


def test_validation_accepts_fresh_structured_content() -> None:
    result = validate(
        {
            "kind": "launch_brief",
            "checklist": ["ship scoped demo"],
            "generated_at": "2999-01-01T00:00:00Z",
        },
        {"acceptance": "brief exists"},
    )

    assert result.passed is True


def test_validation_reports_schema_and_freshness_failures() -> None:
    result = validate(
        {"headline": "stale", "generated_at": "2026-07-10T12:00:00Z"},
        {"acceptance": "fresh structured output"},
    )

    assert result.passed is False
    assert [failure.check for failure in result.failures] == [
        "schema",
        "freshness",
        "semantic_sanity",
    ]
