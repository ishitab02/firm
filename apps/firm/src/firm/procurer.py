from datetime import datetime, timezone
from typing import Protocol

import httpx

from .models import PayAndCallRequest, PayAndCallResponse


class Procurer(Protocol):
    async def pay_and_call(self, request: PayAndCallRequest) -> PayAndCallResponse: ...

    async def refund(self, task_id: str, to_address: str, amount: dict[str, object]) -> dict[str, str]: ...


class HttpProcurer:
    def __init__(self, base_url: str, timeout_seconds: float = 65.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    async def pay_and_call(self, request: PayAndCallRequest) -> PayAndCallResponse:
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            response = await client.post(f"{self.base_url}/pay-and-call", json=request.model_dump())
        response.raise_for_status()
        return PayAndCallResponse.model_validate(response.json())

    async def refund(self, task_id: str, to_address: str, amount: dict[str, object]) -> dict[str, str]:
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            response = await client.post(
                f"{self.base_url}/refund",
                json={"task_id": task_id, "to_address": to_address, "amount": amount},
            )
        response.raise_for_status()
        return dict(response.json())


class SimulatedProcurer:
    async def pay_and_call(self, request: PayAndCallRequest) -> PayAndCallResponse:
        return PayAndCallResponse(
            ok=True,
            result={
                "kind": request.tool,
                "checklist": ["SIMULATED vendor deliverable"],
                "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            },
            receipt={
                "amount": request.max_amount.model_dump(),
                "tx": f"SIMULATED:{request.task_id}:{request.subtask_id}",
                "payment_response": "SIMULATED procurer call",
            },
            latency_ms=50,
        )

    async def refund(self, task_id: str, to_address: str, amount: dict[str, object]) -> dict[str, str]:
        return {"tx": f"SIMULATED:refund:{task_id}"}
