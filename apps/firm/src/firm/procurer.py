from datetime import datetime, timezone
from typing import Protocol

import httpx

from .models import PayAndCallRequest, PayAndCallResponse


class Procurer(Protocol):
    async def pay_and_call(self, request: PayAndCallRequest) -> PayAndCallResponse: ...

    async def refund(self, task_id: str, to_address: str, amount: dict[str, object]) -> dict[str, str]: ...


class HttpProcurer:
    #: Bearer token for the procurer's spending routes. Unset is correct and
    #: normal when the procurer listens on loopback, which is how it runs
    #: locally. It is required once the procurer is on a container network,
    #: because anything that can reach /pay-and-call can spend up to the caps —
    #: the procurer itself refuses a non-loopback bind without one.
    def __init__(self, base_url: str, timeout_seconds: float = 65.0, auth_token: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.auth_token = auth_token

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.auth_token}"} if self.auth_token else {}

    async def pay_and_call(self, request: PayAndCallRequest) -> PayAndCallResponse:
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            response = await client.post(
                f"{self.base_url}/pay-and-call", json=request.model_dump(), headers=self._headers()
            )
        response.raise_for_status()
        return PayAndCallResponse.model_validate(response.json())

    async def refund(self, task_id: str, to_address: str, amount: dict[str, object]) -> dict[str, str]:
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            response = await client.post(
                f"{self.base_url}/refund",
                json={"task_id": task_id, "to_address": to_address, "amount": amount},
                headers=self._headers(),
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
