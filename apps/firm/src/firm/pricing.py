from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import uuid4

from .models import Money, PlanItem, Quote, QuoteError, QuoteRequest

FIRM_FEE = 200_000
TIERS = [1_000_000, 3_000_000, 5_000_000]


def estimate_plan(goal: str) -> list[PlanItem]:
    text = goal.lower()
    if "market" in text and "launch" in text:
        return [
            PlanItem(subtask="market snapshot", capability="market_snapshot"),
            PlanItem(subtask="launch brief", capability="token_launch"),
        ]
    if "market" in text:
        return [PlanItem(subtask="market snapshot", capability="market_snapshot")]
    return [PlanItem(subtask="launch brief", capability="token_launch")]


def calculate_quote_price(
    vendor_estimates: list[Money],
    pricing_mode: Literal["QUOTED_AMOUNT", "TIERS"] = "TIERS",
) -> Money:
    if not vendor_estimates:
        raise ValueError("at least one vendor estimate is required")

    estimate_total = sum(price.units() for price in vendor_estimates)
    most_expensive_retry = max(price.units() for price in vendor_estimates)
    retry_reserve = max(most_expensive_retry, int(estimate_total * 0.3))
    quoted_amount = estimate_total + retry_reserve + FIRM_FEE

    if pricing_mode == "TIERS":
        for tier in TIERS:
            if quoted_amount <= tier:
                return Money.usdt(tier)
        return Money.usdt(TIERS[-1])

    return Money.usdt(quoted_amount)


def build_quote(
    request: QuoteRequest,
    vendor_estimates: list[Money],
    pricing_mode: Literal["QUOTED_AMOUNT", "TIERS"] = "TIERS",
) -> Quote | QuoteError:
    price = calculate_quote_price(vendor_estimates, pricing_mode)
    if price.units() > request.budget_cap.units():
        return QuoteError(
            error={
                "code": "CANNOT_QUOTE_WITHIN_BUDGET",
                "minimum_viable": price.model_dump(),
            }
        )

    return Quote(
        quote_id=f"q_{uuid4().hex[:16]}",
        price=price,
        plan_summary=estimate_plan(request.goal),
        valid_until=datetime.now(timezone.utc) + timedelta(minutes=15),
        pricing_mode=pricing_mode,
    )
