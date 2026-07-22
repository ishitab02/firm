import json
from dataclasses import dataclass
from pathlib import Path

from .models import Constraints, VendorIndexEntry, VendorPerformance
from .validation import _SYMBOL_ALIASES


def clamp(value: int, low: int = 0, high: int = 100) -> int:
    return max(low, min(high, value))


def select_service(services: list, capability: str, request: dict | None):
    """Pick WHICH of a vendor's services to call, not merely whether it has one.

    This existed as `next(s for s in vendor.services if s.capability == capability)`
    — the first match wins. CoinAnk #2013 publishes **80** services, all tagged
    `market_snapshot`, and the first is `getUsBtcEtf`. So every request routed to
    that vendor called the Bitcoin ETF endpoint regardless of what was asked,
    which is how a reviewer asking for ETH was billed for BTC data twice.

    The vendor was not at fault and neither was the capability tag. Nothing ever
    chose between eighty equally-tagged endpoints, and the sibling it should have
    picked — `getUsEthEtf` — was live and payable the whole time.

    Selection is by name, because that is the only signal these services offer:
    none of the eighty documents an argument schema, but they are self-describing
    (`US ETH ETF`, `Pair Last Price`). A service naming the requested symbol is
    preferred; one naming a *different* symbol is actively avoided, since calling
    it is how we produce a confidently wrong answer rather than an honest failure.
    """
    matching = [service for service in services if service.capability == capability]
    if not matching:
        return None

    wanted = None
    if request:
        raw = request.get("symbol") or request.get("asset") or request.get("ticker")
        if isinstance(raw, str) and raw.strip():
            wanted = raw.strip().upper()

    if wanted is None:
        return matching[0]

    aliases = _SYMBOL_ALIASES.get(wanted, (wanted.lower(),))
    others = {
        alias
        for symbol, symbol_aliases in _SYMBOL_ALIASES.items()
        if symbol != wanted
        for alias in symbol_aliases
    }

    def rank(service) -> tuple[int, int]:
        # VendorService carries `tool` and not `endpoint` -- the endpoint lives on
        # the parent index entry, and Pydantic drops the per-service copy. The
        # tool name is the signal that matters anyway ("US ETH ETF"), but read
        # the endpoint defensively so this still works if the model gains it.
        endpoint = getattr(service, "endpoint", "") or ""
        text = f"{service.tool or ''} {endpoint}".lower()
        names_wanted = any(alias in text for alias in aliases)
        names_other = any(alias in text for alias in others)
        if names_wanted and not names_other:
            return (0, matching.index(service))  # exactly what was asked for
        if not names_wanted and not names_other:
            return (1, matching.index(service))  # symbol-agnostic, plausibly usable
        if names_wanted and names_other:
            return (2, matching.index(service))  # mentions both; ambiguous
        return (3, matching.index(service))  # names a different asset — last resort

    return min(matching, key=rank)


def effective_score(vendor: VendorIndexEntry, performance: VendorPerformance | None) -> int:
    adjustment = performance.adjustment if performance else 0
    return clamp(vendor.kya_base_score + adjustment)


def load_vendor_index(path: Path) -> list[VendorIndexEntry]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    vendors = payload["vendors"] if isinstance(payload, dict) and "vendors" in payload else payload
    return [VendorIndexEntry.model_validate(item) for item in vendors]


def rank_candidates(
    vendors: list[VendorIndexEntry],
    performances: dict[str, VendorPerformance],
    capability: str,
    constraints: Constraints,
) -> tuple[list[VendorIndexEntry], list[dict[str, str]]]:
    accepted: list[VendorIndexEntry] = []
    rejected: list[dict[str, str]] = []

    for vendor in vendors:
        if any(service.capability == capability for service in vendor.services) is False:
            continue
        if set(vendor.flags).intersection(constraints.banned_categories):
            rejected.append({"agent_id": vendor.agent_id, "reason": "banned category or flag"})
            continue
        score = effective_score(vendor, performances.get(vendor.agent_id))
        if score < constraints.min_vendor_score:
            rejected.append(
                {
                    "agent_id": vendor.agent_id,
                    "reason": f"trust score {score} below minimum {constraints.min_vendor_score}",
                }
            )
            continue
        accepted.append(vendor)

    accepted.sort(
        key=lambda vendor: effective_score(vendor, performances.get(vendor.agent_id)),
        reverse=True,
    )
    return accepted, rejected


@dataclass
class PerformanceStore:
    records: dict[str, VendorPerformance]

    def get(self, agent_id: str) -> VendorPerformance:
        return self.records.setdefault(agent_id, VendorPerformance(agent_id=agent_id))

    def record_success(self, agent_id: str) -> VendorPerformance:
        record = self.get(agent_id)
        record.calls += 1
        record.successes += 1
        record.adjustment = clamp(record.adjustment + 1, -30, 10)
        return record

    def record_validation_failure(self, agent_id: str) -> VendorPerformance:
        record = self.get(agent_id)
        record.calls += 1
        record.validation_failures += 1
        record.adjustment = clamp(record.adjustment - 10, -30, 10)
        return record

    def record_timeout(self, agent_id: str) -> VendorPerformance:
        record = self.get(agent_id)
        record.calls += 1
        record.timeouts += 1
        record.adjustment = clamp(record.adjustment - 10, -30, 10)
        return record
