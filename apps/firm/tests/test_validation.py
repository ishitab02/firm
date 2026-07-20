from firm.validation import validate


def test_validation_flags_malformed_source_urls() -> None:
    result = validate(
        {
            "observations": ["Liquidity is concentrated in the top venues today."],
            "generated_at": "2999-01-01T00:00:00Z",
            "source_urls": ["not-a-real-url"],
        },
        {"acceptance": "cited sources"},
    )

    assert result.passed is False
    assert "url_liveness" in result.checks_run
    assert any(f.check == "url_liveness" for f in result.failures)


def test_validation_accepts_well_formed_source_urls() -> None:
    result = validate(
        {
            "observations": ["Liquidity is concentrated in the top venues today."],
            "generated_at": "2999-01-01T00:00:00Z",
            "source_urls": ["https://example.com/report"],
        },
        {"acceptance": "cited sources"},
    )

    assert result.passed is True


def test_validation_rejects_too_short_content() -> None:
    result = validate(
        {"observations": ["ok"], "generated_at": "2999-01-01T00:00:00Z"},
        {"acceptance": "a substantive answer"},
    )

    assert result.passed is False
    assert any(f.check == "semantic_sanity" for f in result.failures)


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
