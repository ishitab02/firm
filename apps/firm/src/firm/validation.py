from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

from .models import ValidationFailure, ValidationResult

# A deliverable this short is almost certainly a stub or an error echoed back as
# content, not a real answer. Deterministic floor for the semantic check.
_MIN_MEANINGFUL_CHARS = 12


#: Keys a vendor commonly uses to signal an application-level failure inside an
#: HTTP 200. Checked case-insensitively against the top level of the response.
_ERROR_KEYS = ("error", "errors", "err", "exception")

#: Keys carrying a status code where a non-success value means the vendor
#: refused the request even though the transport succeeded. OKLink uses
#: code: "0" for success, which is the convention across the OKX APIs.
_STATUS_KEYS = ("code", "status", "statusCode", "ret_code", "retCode", "success", "ok")
_SUCCESS_CODES = {"0", "200", "ok", "success", "true"}


def _content_items(deliverable: dict[str, Any]) -> list[Any] | None:
    """Content in the shape our own fixtures use, if present.

    A real marketplace vendor will not use these key names. Absence is not a
    failure — see _payload_text for the shape-agnostic path.
    """
    for key in ("observations", "checklist", "sections"):
        value = deliverable.get(key)
        if isinstance(value, list):
            return value
    return None


def _vendor_error(deliverable: dict[str, Any]) -> str | None:
    """A vendor's own signal that it failed, or None.

    This is the honest replacement for asserting our fixtures' key names. We
    cannot know an arbitrary vendor's success schema, but we CAN recognise the
    conventional ways one reports failure inside an HTTP 200.

    An explicit error field is trusted unconditionally. A *status code* is not,
    and that distinction cost us a real delivery: CoinAnk #2013 returned a full
    BTC-ETF snapshot -- issuer, NAV, holdings, net inflows -- under ``code: "1"``,
    which is its success convention and not in our success set. We fired it,
    recorded a failure against it, and refunded a customer whose work had in fact
    arrived.

    That is the same mistake this module already fixed once for schema keys: we
    asserted our own convention, and every vendor that did not share it was
    condemned. A status code we do not recognise, sitting on top of substantive
    content, is far more likely to be an unfamiliar convention than a failure --
    a genuine error response carries a message and no payload. So the status
    check now only condemns a response that is *also* empty.
    """
    for key in _ERROR_KEYS:
        value = deliverable.get(key)
        if value in (None, "", [], {}, False):
            continue
        return f"vendor reported {key}: {str(value)[:120]}"

    # Substantive content present => an unrecognised status code is not proof of
    # failure. The non-empty and semantic-sanity checks in validate() still apply,
    # so an empty or nonsense payload is caught there rather than waved through.
    has_content = len(_payload_text(deliverable)) >= _MIN_MEANINGFUL_CHARS

    for key in _STATUS_KEYS:
        if key not in deliverable:
            continue
        raw = deliverable[key]
        if isinstance(raw, bool):
            # An explicit boolean false is unambiguous in any convention.
            return None if raw else f"vendor reported {key}: false"
        text = str(raw).strip().lower()
        if text and text not in _SUCCESS_CODES and not has_content:
            return f"vendor reported {key}: {raw}"
    return None


#: Symbols we can recognise by their common written forms. A request naming a
#: subject we do not know how to spot is not judged -- absence of evidence is
#: not a relevance failure.
_SYMBOL_ALIASES: dict[str, tuple[str, ...]] = {
    "BTC": ("btc", "bitcoin", "xbt"),
    "ETH": ("eth", "ethereum", "ether"),
    "SOL": ("sol", "solana"),
    "BNB": ("bnb", "binance coin"),
    "XRP": ("xrp", "ripple"),
    "DOGE": ("doge", "dogecoin"),
    "ADA": ("ada", "cardano"),
    "AVAX": ("avax", "avalanche"),
    "MATIC": ("matic", "polygon"),
    "OKB": ("okb",),
    "USDT": ("usdt", "tether"),
    "USDC": ("usdc",),
}


def _mentions(text: str, aliases: tuple[str, ...]) -> bool:
    """Does the text mention any alias, as a word rather than a substring?

    Substring matching would find "eth" inside "method" and "whether", which is
    exactly the kind of false pass this check exists to prevent.
    """
    import re

    return any(re.search(rf"(?<![a-z0-9]){re.escape(alias)}(?![a-z0-9])", text) for alias in aliases)


def relevance_failure(deliverable_text: str, request: dict[str, Any] | None) -> str | None:
    """Does the deliverable actually concern what the buyer asked about?

    This is the check whose absence let a real reviewer pay twice for the wrong
    asset. He asked for an ETH snapshot; the vendor returned a fixed Bitcoin
    spot-ETF dataset; every other check passed because the payload was
    well-formed, non-empty, fresh and substantive. It was simply about something
    else. `passed=true` on wrong-topic output is worse than a failure, because
    a failure would have refunded him.

    Deliberately narrow, because a relevance heuristic that guesses wrong fires a
    vendor that did nothing wrong and records a false accusation against it:

      - Only runs when the request names a subject symbol we recognise.
      - Only fails when that symbol is absent AND a *different* recognised
        symbol is present. A deliverable that mentions nothing we recognise is
        not judged; the LLM rubric downstream is the right tool for that.
      - Word-boundary matching, so "eth" in "method" is not a match.

    The second condition is what makes it safe. "Asked for ETH, got a document
    all about BTC and never mentioning ETH" is a confident call. "Asked for ETH,
    got prose we cannot classify" is not, and returns None.
    """
    if not request:
        return None

    raw = request.get("symbol") or request.get("asset") or request.get("ticker")
    if not isinstance(raw, str) or not raw.strip():
        return None

    wanted = raw.strip().upper()
    aliases = _SYMBOL_ALIASES.get(wanted)
    if aliases is None:
        return None

    text = deliverable_text.lower()
    if _mentions(text, aliases):
        return None

    others = [
        symbol
        for symbol, other_aliases in _SYMBOL_ALIASES.items()
        if symbol != wanted and _mentions(text, other_aliases)
    ]
    if not others:
        return None

    return (
        f"buyer asked about {wanted}, and the deliverable never mentions it while "
        f"discussing {', '.join(sorted(others))} instead"
    )


def _payload_text(deliverable: dict[str, Any]) -> str:
    """All substantive text in the response, whatever shape it arrived in.

    Used for the non-empty and semantic-sanity floors so they apply to any
    vendor, not only to responses shaped like our mocks. Metadata keys that
    carry no deliverable value are excluded so an empty result cannot pass on
    the strength of its own status code.
    """
    skip = set(_STATUS_KEYS) | set(_ERROR_KEYS) | {"msg", "message", "generated_at", "source_urls"}
    parts: list[str] = []

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if key in skip:
                    continue
                walk(item)
        elif isinstance(value, (list, tuple)):
            for item in value:
                walk(item)
        elif isinstance(value, (str, int, float)):
            text = str(value).strip()
            if text:
                parts.append(text)

    walk(deliverable)
    return " ".join(parts).strip()


def market_snapshot_failures(
    deliverable: dict[str, Any], request: dict[str, Any] | None
) -> list[ValidationFailure]:
    """Validate the exact product contract sold by Firm Express.

    A symbol mention is not enough. An Ethereum ETF-flow table mentions ETH but
    still contains no ETH/USDT timeframe, price action, trend, support, or
    resistance. Those fields are the paid product, so each is required and the
    identifying fields must match the request exactly.
    """
    if not request:
        return []

    failures: list[ValidationFailure] = []
    raw_symbol = request.get("symbol") or request.get("asset") or request.get("ticker")
    raw_timeframe = request.get("timeframe")
    raw_prompt = request.get("prompt")
    if not isinstance(raw_symbol, str) or not raw_symbol.strip():
        failures.append(ValidationFailure(check="request_contract", detail="market snapshot request has no symbol"))
    if not isinstance(raw_timeframe, str) or not raw_timeframe.strip():
        failures.append(ValidationFailure(check="request_contract", detail="market snapshot request has no timeframe"))
    if not isinstance(raw_prompt, str) or not raw_prompt.strip():
        failures.append(ValidationFailure(check="request_contract", detail="market snapshot request has no prompt"))
    if failures:
        return failures

    wanted_symbol = raw_symbol.strip().upper().removesuffix("/USDT").removesuffix("-USDT")
    actual_symbol = deliverable.get("symbol")
    if not isinstance(actual_symbol, str) or actual_symbol.strip().upper() != wanted_symbol:
        failures.append(
            ValidationFailure(
                check="asset_match",
                detail=f"expected symbol {wanted_symbol}, got {actual_symbol!r}",
            )
        )

    wanted_timeframe = raw_timeframe.strip().lower()
    actual_timeframe = deliverable.get("timeframe")
    if not isinstance(actual_timeframe, str) or actual_timeframe.strip().lower() != wanted_timeframe:
        failures.append(
            ValidationFailure(
                check="timeframe_match",
                detail=f"expected timeframe {wanted_timeframe}, got {actual_timeframe!r}",
            )
        )

    actual_prompt = deliverable.get("prompt")
    if not isinstance(actual_prompt, str) or actual_prompt.strip() != raw_prompt.strip():
        failures.append(
            ValidationFailure(
                check="prompt_match",
                detail="deliverable does not identify the exact buyer prompt it fulfilled",
            )
        )

    required = {
        "price": (int, float),
        "price_action": str,
        "trend": (str, dict),
        "support": (int, float, dict),
        "resistance": (int, float, dict),
    }
    for field, expected_type in required.items():
        value = deliverable.get(field)
        if not isinstance(value, expected_type) or value in ("", {}, []):
            failures.append(
                ValidationFailure(
                    check="content_contract",
                    detail=f"market snapshot is missing substantive {field}",
                )
            )

    # A fund-flow response can mention the right chain asset and therefore pass
    # a token heuristic. If the buyer did not ask for funds/ETFs, these terms
    # identify the exact wrong product that caused the paid rejection.
    prompt = raw_prompt.lower()
    text = _payload_text(deliverable).lower()
    asked_for_funds = "etf" in prompt or "fund flow" in prompt or "fund-flow" in prompt
    fund_markers = ("etf", "issuer", "netinflow", "fund holdings", "totalnav")
    if not asked_for_funds and any(marker in text for marker in fund_markers):
        failures.append(
            ValidationFailure(
                check="topic_match",
                detail="buyer requested spot price analysis but output is an ETF/fund dataset",
            )
        )
    return failures


def validate(deliverable: dict[str, Any], subtask_spec: dict[str, Any]) -> ValidationResult:
    """Deterministic validation stack (INTERFACES §6).

    Pure and offline: schema, non-empty content, freshness, URL well-formedness
    where source_urls are present, and a deterministic semantic-sanity floor.
    Actual URL reachability and any LLM rubric live in check_liveness /
    semantic_rubric below, which the worker may run after these pass — they are
    kept out of here so this function stays pure and unit-testable.
    """
    checks_run = ["schema", "non_empty_content", "freshness", "relevance", "semantic_sanity"]
    failures: list[ValidationFailure] = []

    if not isinstance(deliverable, dict):
        failures.append(ValidationFailure(check="schema", detail="deliverable is not an object"))
        return ValidationResult(passed=False, checks_run=checks_run, failures=failures)

    # Schema, shape-agnostically. We do not know an arbitrary marketplace
    # vendor's success schema and must not invent one: asserting our own
    # fixtures' key names here meant every real vendor "failed validation",
    # was fired, and was recorded as having failed — a fabricated accusation
    # against a third party. What we can check is that the vendor did not
    # itself report an error.
    vendor_error = _vendor_error(deliverable)
    if vendor_error is not None:
        failures.append(ValidationFailure(check="schema", detail=vendor_error))

    content = _content_items(deliverable)
    payload_text = _payload_text(deliverable)
    if content is not None and len(content) == 0:
        failures.append(ValidationFailure(check="non_empty_content", detail="content is empty"))
    elif not payload_text:
        failures.append(ValidationFailure(check="non_empty_content", detail="response carries no content"))

    # Does it concern what was asked about? Everything above this line can pass
    # on a well-formed answer to a different question.
    off_topic = relevance_failure(payload_text, subtask_spec.get("request"))
    if off_topic is not None:
        failures.append(ValidationFailure(check="relevance", detail=off_topic))

    if subtask_spec.get("acceptance") == "market_snapshot" and subtask_spec.get("request"):
        checks_run.extend(
            [
                "request_contract",
                "asset_match",
                "timeframe_match",
                "prompt_match",
                "content_contract",
                "topic_match",
            ]
        )
        failures.extend(market_snapshot_failures(deliverable, subtask_spec.get("request")))

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
    # No timestamp is NOT a failure. INTERFACES §6 specifies freshness "where
    # timestamps exist"; most vendors return none, and failing them for it
    # fires correct work.

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
    if content:
        text = " ".join(str(item) for item in content if isinstance(item, (str, int, float))).strip()
    else:
        text = payload_text
    if text and len(text) < _MIN_MEANINGFUL_CHARS:
        failures.append(
            ValidationFailure(
                check="semantic_sanity",
                detail="content is too short to be a meaningful deliverable",
            )
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
