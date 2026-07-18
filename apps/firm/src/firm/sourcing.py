import json
from dataclasses import dataclass
from pathlib import Path

from .models import Constraints, VendorIndexEntry, VendorPerformance


def clamp(value: int, low: int = 0, high: int = 100) -> int:
    return max(low, min(high, value))


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
