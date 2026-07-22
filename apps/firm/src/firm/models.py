from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class Money(BaseModel):
    amount: str
    decimals: int = 6
    token: str = "USDT"

    @field_validator("amount")
    @classmethod
    def amount_is_base_units(cls, value: str) -> str:
        if not value.isdigit():
            raise ValueError("amount must be a non-negative base-unit integer string")
        return value

    def units(self) -> int:
        return int(self.amount)

    @classmethod
    def usdt(cls, amount: int) -> "Money":
        return cls(amount=str(amount), decimals=6, token="USDT")


class Constraints(BaseModel):
    deadline_minutes: int = Field(default=60, ge=1)
    min_vendor_score: int = Field(default=60, ge=0, le=100)
    banned_categories: list[str] = Field(default_factory=list)


class QuoteRequest(BaseModel):
    goal: str = Field(min_length=1)
    budget_cap: Money
    constraints: Constraints = Field(default_factory=Constraints)


class PlanItem(BaseModel):
    subtask: str
    capability: str
    max_amount: Money | None = None


class Quote(BaseModel):
    quote_id: str
    price: Money
    plan_summary: list[PlanItem]
    valid_until: datetime
    guarantee: str = "full refund if not delivered"
    quoted_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    pricing_mode: Literal["QUOTED_AMOUNT", "TIERS"] = "TIERS"
    # The buyer's sourcing constraints, carried on the stored job quote so the
    # worker honours them. Absent on a bare get_quote response and on legacy
    # jobs, where it defaults to the permissive baseline.
    constraints: Constraints = Field(default_factory=Constraints)
    # The facilitator-verified payer, captured by the gateway at execute so a
    # refund pays back the real buyer. None on bypassed runs (no real payer),
    # where the refund falls back to the configured default address.
    buyer_address: str | None = None


class QuoteError(BaseModel):
    error: dict[str, Any]


class JobState(StrEnum):
    QUOTED = "quoted"
    PAID = "paid"
    PLANNING = "planning"
    SOURCING = "sourcing"
    VETTING = "vetting"
    PROCURING = "procuring"
    VALIDATING = "validating"
    ASSEMBLING = "assembling"
    BOOKING = "booking"
    COMPLETE = "complete"
    REFUNDING = "refunding"
    REFUNDED = "refunded"
    FAILED_REFUNDED = "failed_refunded"


class ProgressItem(BaseModel):
    subtask_id: str
    state: str
    note: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class VendorService(BaseModel):
    tool: str
    price: Money
    capability: str
    #: The service's OWN endpoint. The index publishes one per service and this
    #: model used to drop it, so every call fell back to the vendor-wide
    #: `VendorIndexEntry.endpoint` -- which is simply the first service's URL.
    #: CoinAnk lists 80 services under one agent, so an ETH request selected the
    #: ETH service and then posted to the BTC endpoint anyway. Optional because
    #: older index files predate the field; callers fall back when it is None.
    endpoint: str | None = None
    #: What the vendor published about its own request body, when it published
    #: anything: {"args": {...}, "source": "..."} from tools/vendor-index.
    #: None means unknown — never "takes no arguments". Only a handful of
    #: marketplace services document anything at all.
    documented_example_args: dict[str, Any] | None = None


class VendorIndexEntry(BaseModel):
    agent_id: str
    name: str
    endpoint: str
    services: list[VendorService]
    kya_base_score: int = Field(ge=0, le=100)
    flags: list[str] = Field(default_factory=list)
    last_verified_at: datetime | str


class VendorPerformance(BaseModel):
    agent_id: str
    calls: int = 0
    successes: int = 0
    validation_failures: int = 0
    timeouts: int = 0
    last_failure_at: datetime | None = None
    adjustment: int = Field(default=0, ge=-30, le=10)


class ValidationFailure(BaseModel):
    check: str
    detail: str


class ValidationResult(BaseModel):
    passed: bool
    checks_run: list[str]
    failures: list[ValidationFailure] = Field(default_factory=list)


class VendorRef(BaseModel):
    agent_id: str
    name: str | None = None


class VendorRejection(BaseModel):
    agent_id: str
    reason: str


class VendorFiring(BaseModel):
    agent_id: str
    subtask: str
    reason: str
    cost_absorbed: Money


class HireReceipt(BaseModel):
    agent_id: str
    subtask: str
    cost: Money
    tx: str
    validation: dict[str, Any]


class Economics(BaseModel):
    user_price: Money
    actual_vendor_costs: Money
    margin_retained_or_absorbed: dict[str, str]


class BooksReceipt(BaseModel):
    by: str = "Treasury Copilot (our own product, intra-team payment, disclosed)"
    cost: Money
    tx: str
    statement: str


class ProvenanceReceipt(BaseModel):
    task_id: str
    goal: str
    quote: dict[str, Any]
    vendors_vetted: int
    vendors_rejected: list[VendorRejection]
    vendors_fired: list[VendorFiring]
    hires: list[HireReceipt]
    economics: Economics
    books: BooksReceipt
    guarantee_status: Literal["delivered", "refunded"]
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class PayAndCallRequest(BaseModel):
    vendor_endpoint: str
    tool: str
    args: dict[str, Any]
    max_amount: Money
    task_id: str
    subtask_id: str


class PayAndCallReceipt(BaseModel):
    amount: Money
    tx: str
    payment_response: str


class PayAndCallResponse(BaseModel):
    ok: bool
    result: dict[str, Any] | None = None
    receipt: PayAndCallReceipt | None = None
    latency_ms: int | None = None
    error_code: str | None = None
    detail: str | None = None


class FirmTask(BaseModel):
    task_id: str
    goal: str
    quote: Quote
    #: The vendor-specific request body for this job. Real vendors have real
    #: schemas, and payment happens before a vendor validates the body, so
    #: sending a generic shape means paying for a 400.
    #:
    #: Buyer constraints deliberately do NOT live here — they ride on
    #: `quote.constraints`, because they are quoted against. One source of
    #: truth; do not add a second.
    params: dict[str, Any] = Field(default_factory=dict)
    state: JobState = JobState.PLANNING
    progress: list[ProgressItem] = Field(default_factory=list)
    deliverable: dict[str, Any] | None = None
    provenance: ProvenanceReceipt | None = None
    refund: dict[str, Any] | None = None


class StatusResponse(BaseModel):
    state: str
    progress: list[ProgressItem]


class ResultResponse(BaseModel):
    deliverable: dict[str, Any]
    provenance: ProvenanceReceipt
