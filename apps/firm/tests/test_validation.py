from datetime import datetime, timezone

from firm.validation import relevance_failure, validate, _vendor_error


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


def test_unrecognised_status_code_with_real_content_is_not_a_failure():
    """CoinAnk #2013 returns a full BTC-ETF snapshot under ``code: "1"``.

    That is its success convention, not an error. Condemning it fired a vendor
    that had delivered, recorded a failure against it, and refunded a customer
    whose work had arrived -- the same class of mistake this module already
    fixed for schema keys.
    """
    coinank = {
        "code": "1",
        "data": [
            {
                "ticker": "IBIT",
                "issuer": "BlackRock",
                "etfName": "iShares Bitcoin Trust",
                "price": 37.67,
                "netInflow": 163892400,
                "totalNav": 56219587998.64,
            }
        ],
    }
    assert _vendor_error(coinank) is None


def test_unrecognised_status_code_with_no_content_still_fails():
    """The guard must keep working where it actually matters: an empty body."""
    assert _vendor_error({"code": "1"}) is not None
    assert _vendor_error({"code": "500", "data": []}) is not None


def test_explicit_error_field_still_condemns_even_with_content():
    """An error field is unambiguous in any convention; content cannot excuse it."""
    body = {"error": "rate limited", "data": [{"ticker": "IBIT", "price": 37.67}]}
    assert _vendor_error(body) is not None


def test_boolean_false_status_still_fails_regardless_of_content():
    body = {"success": False, "data": [{"ticker": "IBIT", "price": 37.67}]}
    assert _vendor_error(body) is not None


def test_recognised_success_codes_still_pass():
    for code in ("0", "200", "ok", "success"):
        assert _vendor_error({"code": code, "data": [{"x": "yyyyyyyyyyyy"}]}) is None


# --- relevance -------------------------------------------------------------
# The check whose absence let OKX's reviewer pay 0.1 USDT twice for the wrong
# asset. He asked for an ETH 4h snapshot; the vendor returned a fixed Bitcoin
# spot-ETF dataset; every other check passed because the payload was
# well-formed, non-empty, fresh and substantive. It was about something else.

_BTC_ETF_PAYLOAD = (
    "IBIT iShares Bitcoin Trust BlackRock nav 36.35 btcAmount 734762.151 "
    "FBTC Fidelity Wise Origin Bitcoin netInflow 163892400 Coinbase custodian"
)


def test_wrong_asset_is_a_relevance_failure():
    detail = relevance_failure(_BTC_ETF_PAYLOAD, {"symbol": "ETH", "timeframe": "4h"})
    assert detail is not None
    assert "ETH" in detail and "BTC" in detail


def test_right_asset_passes():
    assert relevance_failure(_BTC_ETF_PAYLOAD, {"symbol": "BTC"}) is None


def test_alias_counts_as_a_mention():
    assert relevance_failure("A summary of Ethereum price action", {"symbol": "ETH"}) is None


def test_substring_is_not_a_mention():
    """'eth' inside 'method'/'whether' must not count, or the check is useless."""
    detail = relevance_failure("Our method determines whether bitcoin rose", {"symbol": "ETH"})
    assert detail is not None


def test_unclassifiable_output_is_not_judged():
    """No recognised symbol anywhere => we cannot tell, so we do not accuse."""
    assert relevance_failure("A general commentary with no tickers at all", {"symbol": "ETH"}) is None


def test_no_symbol_in_request_is_not_judged():
    assert relevance_failure(_BTC_ETF_PAYLOAD, {"timeframe": "4h"}) is None
    assert relevance_failure(_BTC_ETF_PAYLOAD, {}) is None
    assert relevance_failure(_BTC_ETF_PAYLOAD, None) is None


def test_unknown_symbol_is_not_judged():
    """A ticker we have no aliases for cannot be searched for honestly."""
    assert relevance_failure(_BTC_ETF_PAYLOAD, {"symbol": "WIFHAT"}) is None


def test_end_to_end_the_reviewers_job_now_fails_validation():
    """The exact shape that was settled and never refunded."""
    deliverable = {"code": "1", "data": [{"ticker": "IBIT", "etfName": "iShares Bitcoin Trust", "price": 37.67}]}
    spec = {
        "acceptance": "market_snapshot",
        "request": {"symbol": "ETH", "timeframe": "4h", "prompt": "price action, trend, support and resistance"},
    }
    result = validate(deliverable, spec)
    assert result.passed is False
    assert any(f.check == "relevance" for f in result.failures)


def test_end_to_end_matching_asset_still_passes():
    deliverable = {"code": "1", "data": [{"ticker": "IBIT", "etfName": "iShares Bitcoin Trust", "price": 37.67}]}
    spec = {
        "acceptance": "market_snapshot",
        "request": {"symbol": "BTC", "timeframe": "1h", "prompt": "price action, trend, support and resistance"},
    }
    result = validate(deliverable, spec)
    assert result.passed is False
    assert any(f.check in {"content_contract", "topic_match"} for f in result.failures)


def test_same_asset_etf_payload_is_not_a_spot_market_snapshot():
    deliverable = {
        "code": "1",
        "data": [{"ticker": "ETHA", "etfName": "iShares Ethereum Trust ETF", "netInflow": 12_000_000}],
    }
    spec = {
        "acceptance": "market_snapshot",
        "request": {"symbol": "ETH", "timeframe": "4h", "prompt": "price action, trend, support and resistance"},
    }
    result = validate(deliverable, spec)
    assert result.passed is False
    assert any(f.check == "topic_match" for f in result.failures)


def test_wrong_timeframe_fails_even_when_every_content_field_exists():
    deliverable = {
        "symbol": "ETH",
        "timeframe": "1h",
        "prompt": "price action, trend, support and resistance",
        "price": 3500.0,
        "price_action": "ETH-USDT rose over the sampled candles.",
        "trend": "bullish",
        "support": 3400.0,
        "resistance": 3600.0,
    }
    spec = {
        "acceptance": "market_snapshot",
        "request": {"symbol": "ETH", "timeframe": "4h", "prompt": "price action, trend, support and resistance"},
    }
    result = validate(deliverable, spec)
    assert result.passed is False
    assert any(f.check == "timeframe_match" for f in result.failures)
