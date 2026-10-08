"""Temporary, non-privileged transport fixture. This is NOT a deployment API."""

import argparse
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import threading
import time
from uuid import UUID


PREFIX = "/__codex_proxy_probe/v1"
# Public test marker, NOT a credential. It cannot authorize any operation.
PUBLIC_FIXTURE = "clima-proxy-fixture-only-20261008"
BODY_LIMIT = 1024
MAX_REQUESTS = 60


def valid_uuid(value):
    try:
        return str(UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


class ProbeState:
    def __init__(self, lifetime=3600, clock=time.monotonic):
        if not 1 <= lifetime <= 3600:
            raise ValueError("Probe lifetime must be between 1 and 3600 seconds")
        self.clock = clock
        self.expires = clock() + lifetime
        self.lock = threading.Lock()
        self.calls = deque()
        self.seen = set()

    def admit(self):
        with self.lock:
            now = self.clock()
            if now >= self.expires:
                return 410
            while self.calls and self.calls[0] <= now - 60:
                self.calls.popleft()
            if len(self.calls) >= MAX_REQUESTS:
                return 429
            self.calls.append(now)
            return 200

    def consume(self, request_id, nonce):
        with self.lock:
            if request_id in self.seen or nonce in self.seen:
                return False
            # Bounded by lifetime/rate limit; no persistent files are required.
            self.seen.update((request_id, nonce))
            return True


class ProbeServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, address, allowed_peer, state=None):
        self.allowed_peer = allowed_peer
        self.state = state or ProbeState()
        self.slots = threading.BoundedSemaphore(4)
        super().__init__(address, ProbeHandler)

    def verify_request(self, request, client_address):
        return client_address[0] == self.allowed_peer

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        # Never print request details, request bodies, headers, or tracebacks.
        pass


class ProbeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    server_version = "CloudTransportFixture"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(3)

    def log_message(self, format, *args):
        pass

    def send_error(self, code, message=None, explain=None):
        self.reply(code, {"ok": False})

    def reply(self, status, payload):
        data = json.dumps(payload, separators=(",", ":")).encode("ascii")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def allowed(self):
        status = self.server.state.admit()
        if status != 200:
            self.reply(status, {"ok": False})
            return False
        return True

    def do_GET(self):
        if self.allowed():
            if self.path == PREFIX + "/health":
                self.reply(200, {"ok": True, "probeOnly": True})
            else:
                self.reply(404, {"ok": False})

    def do_POST(self):
        if not self.allowed():
            return
        if self.path != PREFIX + "/check":
            self.reply(404, {"ok": False})
            return
        single_headers = (
            "Content-Length", "Content-Type", "Authorization", "x-api-key",
            "X-Cloud-Probe-Token", "Idempotency-Key", "X-Request-Nonce",
        )
        if any(len(self.headers.get_all(key, [])) > 1 for key in single_headers):
            self.reply(400, {"ok": False})
            return
        length = self.headers.get("Content-Length", "")
        if self.headers.get("Transfer-Encoding") or not length.isascii() or not length.isdigit():
            self.reply(400, {"ok": False})
            return
        if not 1 <= int(length) <= BODY_LIMIT:
            self.reply(413, {"ok": False})
            return
        if self.headers.get("Content-Type") != "application/json":
            self.reply(415, {"ok": False})
            return
        raw = self.rfile.read(int(length))
        if len(raw) != int(length):
            self.reply(400, {"ok": False})
            return
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeError):
            self.reply(400, {"ok": False})
            return
        if not isinstance(data, dict) or set(data) != {"mode", "requestId", "marker"}:
            self.reply(400, {"ok": False})
            return
        modes = {"bearer": "Authorization", "x-api-key": "x-api-key", "custom": "X-Cloud-Probe-Token"}
        if not isinstance(data["mode"], str) or data["mode"] not in modes or not valid_uuid(data["requestId"]):
            self.reply(400, {"ok": False})
            return
        nonce = self.headers.get("X-Request-Nonce", "")
        if not valid_uuid(nonce) or nonce == data["requestId"]:
            self.reply(400, {"ok": False})
            return
        if not self.server.state.consume(data["requestId"], nonce):
            self.reply(409, {"ok": False})
            return
        header = self.headers.get(modes[data["mode"]], "")
        expected = ("Bearer " if data["mode"] == "bearer" else "") + PUBLIC_FIXTURE
        matched = hmac.compare_digest(header.encode("utf-8"), expected.encode("ascii"))
        self.reply(200, {
            "credentialMatched": matched,
            "jsonMatched": data["marker"] == "synthetic-only",
            "idempotencyHeaderReceived": self.headers.get("Idempotency-Key") == data["requestId"],
            "nonceHeaderReceived": True,
        })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9087)
    parser.add_argument("--peer", default="127.0.0.1")
    args = parser.parse_args()
    with ProbeServer((args.bind, args.port), args.peer) as server:
        server.serve_forever(poll_interval=0.2)


if __name__ == "__main__":
    main()
