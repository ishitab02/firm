"""Liveness surface for the worker loop.

The worker is the process nobody watches. The gateway takes the money and the
procurer moves it, but neither turns a paid job into a deliverable — that is
this loop, and if it stops the visible symptom is nothing at all: jobs sit at
`paid`, the gateway keeps accepting payments, and from a buyer's side that is
indistinguishable from an agent that took the money and vanished.

Fly restarts a process that *exits*. A hang is not an exit, so `restart:
unless-stopped` does not cover the failure that actually matters.

The trap this deliberately avoids: a health endpoint served from its own task
answers 200 happily while the loop it claims to represent is wedged, because
serving HTTP and claiming jobs are different coroutines. So health here is
*derived from the loop*, not from the process. The loop stamps a heartbeat each
iteration and the endpoint reports how stale that stamp is. A wedged loop stops
stamping and the check fails, which is the entire point.

The staleness threshold is `worker_stale_after_seconds` — deliberately the same
constant that governs job reclamation. That makes two things coincide that
should always coincide: the moment this worker is declared unhealthy is the
moment another worker becomes entitled to steal its job. Using two different
numbers would create a window where a job is reclaimed from a worker still
considered healthy, or vice versa.
"""

import asyncio
import json
import socket
import time
from dataclasses import dataclass, field


@dataclass
class Heartbeat:
    """Shared liveness stamp, written by the loop and read by the endpoint."""

    stale_after_seconds: float
    started_at: float = field(default_factory=time.monotonic)
    last_tick: float = field(default_factory=time.monotonic)
    #: Loop iterations completed. A flat count across two checks is the signal
    #: that the loop is alive but making no progress.
    ticks: int = 0
    #: The task currently being worked, for operator context. Never a secret.
    current_task_id: str | None = None

    def tick(self, task_id: str | None = None) -> None:
        self.last_tick = time.monotonic()
        self.ticks += 1
        self.current_task_id = task_id

    def seconds_since_tick(self) -> float:
        return time.monotonic() - self.last_tick

    def healthy(self) -> bool:
        return self.seconds_since_tick() < self.stale_after_seconds

    def snapshot(self) -> dict:
        return {
            "ok": self.healthy(),
            "service": "firm-worker",
            "uptime_seconds": round(time.monotonic() - self.started_at, 1),
            "seconds_since_tick": round(self.seconds_since_tick(), 1),
            "stale_after_seconds": self.stale_after_seconds,
            "ticks": self.ticks,
            "current_task_id": self.current_task_id,
        }


async def serve_health(heartbeat: Heartbeat, host: str, port: int) -> asyncio.AbstractServer:
    """Minimal HTTP health surface. No framework, no new dependency.

    Returns 200 while the loop is ticking and 503 once it has gone stale, so a
    platform health check restarts a wedged worker rather than leaving it to
    absorb jobs it will never finish.
    """

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            # Read and discard the request line and headers; every path answers
            # the same thing, and a health surface should not be a parser.
            try:
                await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=2.0)
            except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError):
                pass

            body = json.dumps(heartbeat.snapshot()).encode("utf-8")
            status = b"200 OK" if heartbeat.healthy() else b"503 Service Unavailable"
            writer.write(
                b"HTTP/1.1 " + status + b"\r\n"
                b"content-type: application/json\r\n"
                b"content-length: " + str(len(body)).encode() + b"\r\n"
                b"connection: close\r\n\r\n" + body
            )
            await writer.drain()
        except (ConnectionResetError, BrokenPipeError):
            pass
        finally:
            writer.close()

    return await asyncio.start_server(handle, sock=_dual_stack_socket(host, port))


def _dual_stack_socket(host: str, port: int) -> socket.socket:
    """Bind so BOTH IPv4 and IPv6 callers are answered.

    `asyncio.start_server(host="::")` sets IPV6_V6ONLY, so the listener accepts
    ::1 and refuses 127.0.0.1. That is not a theoretical edge: the container's
    own health check connects over IPv4 loopback and got connection-refused
    while the server was running perfectly on IPv6 — a health check that fails
    while the thing it checks is fine, which is the worst kind.

    Fly needs both: 6PN is IPv6, and platform checks arrive on IPv4. So build
    the socket explicitly rather than letting asyncio choose.
    """
    if ":" not in host:
        return socket.create_server((host, port), reuse_port=False)
    server = socket.create_server(
        (host, port), family=socket.AF_INET6, dualstack_ipv6=socket.has_dualstack_ipv6(), reuse_port=False
    )
    return server
