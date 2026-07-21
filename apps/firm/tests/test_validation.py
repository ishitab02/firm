from datetime import datetime, timezone

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


def test_validation_reports_freshness_failure_on_a_stale_timestamp() -> None:
    """Updated 2026-07-21. This previously asserted that a response without our
    own fixtures' key names was a *schema* failure. That assumption is what fired
    OKLink for delivering correctly, so the schema check no longer asserts key
    names — only that the vendor did not report its own error. A stale timestamp
    is still a failure, because the vendor supplied the timestamp itself."""
    # Content is deliberately long enough to clear the semantic floor, so this
    # test isolates freshness rather than tripping two checks at once.
    result = validate(
        {"headline": "a stale but substantive headline", "generated_at": "2026-07-10T12:00:00Z"},
        {"acceptance": "fresh structured output"},
    )

    assert result.passed is False
    assert [failure.check for failure in result.failures] == ["freshness"]


# --- Real vendor shapes -----------------------------------------------------
#
# These pin the bug found by the live G2 run on 2026-07-21: the validator only
# recognised the key names our own mock fixtures emit, so OKLink #2023 returned
# a correct response, failed validation, was fired, and was recorded in
# vendor_performance as having failed. We paid for the call and libelled a real
# third party for delivering correctly.

OKLINK_REAL_RESPONSE = {
    "msg": "",
    "code": "0",
    "data": (
        '[{"address":"0x0000000000000000000000000000000000000000",'
        '"balance":"13398.477278027753524199","balanceRaw":"13398477278027753524199",'
        '"balanceSymbol":"ETH","blockTime":"1729345547000","height":"21000000",'
        '"tokenContractAddress":""}]'
    ),
}


def test_accepts_a_real_vendor_response_that_uses_none_of_our_key_names():
    result = validate(OKLINK_REAL_RESPONSE, {"acceptance": "market_snapshot"})
    assert result.passed, [f.detail for f in result.failures]


def test_missing_timestamp_is_not_a_failure():
    """INTERFACES §6 specifies freshness 'where timestamps exist'. Most vendors
    return none, and failing them for it fires correct work."""
    result = validate({"data": "a substantive payload of text"}, {"acceptance": "x"})
    assert result.passed, [f.detail for f in result.failures]


def test_still_enforces_freshness_when_a_timestamp_is_present():
    stale = {"observations": ["something real and long enough"], "generated_at": "2020-01-01T00:00:00Z"}
    result = validate(stale, {"acceptance": "x"})
    assert not result.passed
    assert any(f.check == "freshness" for f in result.failures)


def test_rejects_a_vendor_that_reports_its_own_error_inside_http_200():
    result = validate({"code": "50011", "msg": "rate limited", "data": None}, {"acceptance": "x"})
    assert not result.passed
    assert any("50011" in f.detail for f in result.failures)


def test_rejects_an_error_key_even_with_a_success_code():
    result = validate({"code": "0", "error": "upstream unavailable"}, {"acceptance": "x"})
    assert not result.passed
    assert any(f.check == "schema" for f in result.failures)


def test_a_success_code_alone_cannot_pass_an_empty_result():
    """The status code is metadata, not content: a vendor returning code 0 and
    nothing else has delivered nothing and must not be paid-and-accepted."""
    result = validate({"code": "0", "msg": "", "data": []}, {"acceptance": "x"})
    assert not result.passed
    assert any(f.check == "non_empty_content" for f in result.failures)


def test_boolean_status_fields_are_understood_in_both_directions():
    assert validate({"success": True, "data": "a real payload here"}, {"acceptance": "x"}).passed
    assert not validate({"success": False, "data": "a real payload here"}, {"acceptance": "x"}).passed


def test_our_own_fixture_shape_still_passes_unchanged():
    mock = {
        "kind": "market_snapshot",
        "observations": ["Spot liquidity is concentrated in the top venues."],
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    assert validate(mock, {"acceptance": "market_snapshot"}).passed
