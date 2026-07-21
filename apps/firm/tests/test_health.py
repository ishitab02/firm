import asyncio
import json

from firm.health import Heartbeat, serve_health


def test_a_fresh_heartbeat_is_healthy() -> None:
    beat = Heartbeat(stale_after_seconds=900)
    assert beat.healthy()
    assert beat.snapshot()["ok"] is True


def test_a_stale_heartbeat_is_unhealthy() -> None:
    """The whole point: a loop that stops ticking must stop reporting healthy.

    A health endpoint served from its own task answers 200 happily while the
    loop it represents is wedged, because serving HTTP and claiming jobs are
    different coroutines. Health is derived from the loop's own stamp instead.
    """
    beat = Heartbeat(stale_after_seconds=900)
    # Simulate a loop that last ticked longer ago than the window.
    beat.last_tick -= 901
    assert not beat.healthy()
    assert beat.snapshot()["ok"] is False


def test_ticking_recovers_health_and_counts_progress() -> None:
    beat = Heartbeat(stale_after_seconds=10)
    beat.last_tick -= 11
    assert not beat.healthy()

    beat.tick("t_abc")
    assert beat.healthy()
    assert beat.ticks == 1
    assert beat.snapshot()["current_task_id"] == "t_abc"


def test_the_endpoint_reports_503_once_the_loop_wedges() -> None:
    """A platform health check must be able to restart a wedged worker, which
    means the HTTP status has to change — not just the body."""

    async def scenario() -> tuple[int, dict, int, dict]:
        beat = Heartbeat(stale_after_seconds=900)
        server = await serve_health(beat, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]

        async def get() -> tuple[int, dict]:
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.write(b"GET /health HTTP/1.1\r\nhost: x\r\n\r\n")
            await writer.drain()
            raw = await reader.read()
            writer.close()
            head, _, body = raw.partition(b"\r\n\r\n")
            status = int(head.split(b" ")[1])
            return status, json.loads(body)

        healthy_status, healthy_body = await get()
        beat.last_tick -= 901
        wedged_status, wedged_body = await get()

        server.close()
        await server.wait_closed()
        return healthy_status, healthy_body, wedged_status, wedged_body

    ok_status, ok_body, bad_status, bad_body = asyncio.run(scenario())

    assert ok_status == 200
    assert ok_body["ok"] is True
    assert bad_status == 503
    assert bad_body["ok"] is False
    assert bad_body["seconds_since_tick"] >= 900


def test_the_threshold_matches_the_job_reclaim_window() -> None:
    """Unhealthy and reclaimable must coincide.

    If they differ there is a window where another worker is entitled to steal
    a job from a worker still considered healthy — or where a worker is
    restarted while its job is still safely its own.
    """
    from firm.config import Settings

    settings = Settings()
    beat = Heartbeat(stale_after_seconds=settings.worker_stale_after_seconds)
    assert beat.stale_after_seconds == settings.worker_stale_after_seconds


def test_the_endpoint_answers_ipv4_and_ipv6() -> None:
    """asyncio's default `::` bind sets IPV6_V6ONLY and refuses 127.0.0.1.

    That produced a check failing against a server that was running fine. Fly
    needs both: 6PN is IPv6, platform checks arrive on IPv4.
    """
    import socket as _socket

    async def scenario() -> list[str]:
        beat = Heartbeat(stale_after_seconds=900)
        server = await serve_health(beat, "::", 0)
        port = server.sockets[0].getsockname()[1]

        reached = []
        for family, host in [(_socket.AF_INET, "127.0.0.1"), (_socket.AF_INET6, "::1")]:
            sock = _socket.socket(family, _socket.SOCK_STREAM)
            sock.settimeout(3)
            try:
                sock.connect((host, port))
                reached.append(host)
            except OSError:
                pass
            finally:
                sock.close()

        server.close()
        await server.wait_closed()
        return reached

    if not _socket.has_dualstack_ipv6():
        return  # platform cannot express it; the container can
    assert asyncio.run(scenario()) == ["127.0.0.1", "::1"]
