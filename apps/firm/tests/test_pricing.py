from firm.models import Money, QuoteError, QuoteRequest
from firm.pricing import calculate_quote_price, build_quote


def test_quote_math_uses_retry_reserve_and_flat_fee() -> None:
    price = calculate_quote_price(
        [Money.usdt(300_000), Money.usdt(200_000)],
        pricing_mode="QUOTED_AMOUNT",
    )

    assert price.amount == "1000000"


def test_tier_mode_rounds_up_to_nearest_tier() -> None:
    price = calculate_quote_price([Money.usdt(300_000)], pricing_mode="TIERS")

    assert price.amount == "1000000"


def test_budget_too_small_returns_contract_error() -> None:
    response = build_quote(
        QuoteRequest(goal="market snapshot", budget_cap=Money.usdt(100_000)),
        [Money.usdt(300_000)],
        pricing_mode="QUOTED_AMOUNT",
    )

    assert isinstance(response, QuoteError)
    assert response.error["code"] == "CANNOT_QUOTE_WITHIN_BUDGET"
