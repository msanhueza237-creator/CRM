import contextlib
import http.client
import io
import json
import threading
import unittest
from uuid import uuid4

from proxy_probe import MAX_REQUESTS, PREFIX, PUBLIC_FIXTURE, ProbeServer, ProbeState


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.server = ProbeServer(("127.0.0.1", 0), "127.0.0.1")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method="POST", path=PREFIX + "/check", data=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        body = None if data is None else json.dumps(data)
        try:
            conn.request(method, path, body, headers or {})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), json.loads(response.read())
        finally:
            conn.close()

    def fixture(self, mode="bearer", credential=PUBLIC_FIXTURE):
        request_id = str(uuid4())
        header = {"bearer": "Authorization", "x-api-key": "x-api-key", "custom": "X-Cloud-Probe-Token"}[mode]
        return {"mode": mode, "requestId": request_id, "marker": "synthetic-only"}, {
            "Content-Type": "application/json", "Idempotency-Key": request_id,
            "X-Request-Nonce": str(uuid4()), header: ("Bearer " if mode == "bearer" else "") + credential,
        }

    def test_health_is_explicitly_not_a_release_api(self):
        status, headers, body = self.request("GET", PREFIX + "/health")
        self.assertEqual((status, body), (200, {"ok": True, "probeOnly": True}))
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_three_formats_are_supported_without_reflection(self):
        for mode in ("bearer", "x-api-key", "custom"):
            with self.subTest(mode=mode):
                data, headers = self.fixture(mode)
                status, _, body = self.request(data=data, headers=headers)
                self.assertEqual(status, 200)
                self.assertEqual(set(body.values()), {True})
                self.assertEqual(len(body), 4)
                self.assertNotIn(PUBLIC_FIXTURE, json.dumps(body))

    def test_placeholder_without_substitution_does_not_pass(self):
        data, headers = self.fixture(credential="UNSUBSTITUTED_PLACEHOLDER")
        status, _, body = self.request(data=data, headers=headers)
        self.assertEqual(status, 200)
        self.assertFalse(body["credentialMatched"])

    def test_no_request_or_secret_logs(self):
        data, headers = self.fixture(credential="SYNTHETIC_BAD_VALUE")
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured), contextlib.redirect_stdout(captured):
            result = self.request(data=data, headers=headers)
        self.assertEqual(captured.getvalue(), "")
        self.assertNotIn("SYNTHETIC_BAD_VALUE", json.dumps(result))

    def test_missing_credential_fails_match(self):
        data, headers = self.fixture()
        del headers["Authorization"]
        self.assertFalse(self.request(data=data, headers=headers)[2]["credentialMatched"])

    def test_replay_is_rejected(self):
        data, headers = self.fixture()
        self.assertEqual(self.request(data=data, headers=headers)[0], 200)
        self.assertEqual(self.request(data=data, headers=headers)[0], 409)
        headers["X-Request-Nonce"] = str(uuid4())
        self.assertEqual(self.request(data=data, headers=headers)[0], 409)

    def test_nonce_reuse_with_new_request_is_rejected(self):
        data, headers = self.fixture()
        self.assertEqual(self.request(data=data, headers=headers)[0], 200)
        data["requestId"] = str(uuid4())
        headers["Idempotency-Key"] = data["requestId"]
        self.assertEqual(self.request(data=data, headers=headers)[0], 409)

    def test_arbitrary_operations_paths_and_query_strings_are_rejected(self):
        for path in ("/deploy", "/execute", "/status", PREFIX + "/check?token=test", PREFIX + "/../check"):
            self.assertEqual(self.request(path=path)[0], 404)
        self.assertEqual(self.request("DELETE", PREFIX + "/check")[0], 501)

    def test_invalid_input(self):
        for field, value in (("mode", "deploy"), ("mode", []), ("requestId", "not-a-uuid")):
            data, headers = self.fixture()
            data[field] = value
            self.assertEqual(self.request(data=data, headers=headers)[0], 400)
        data, headers = self.fixture()
        data["command"] = "ignored-not-executed"
        self.assertEqual(self.request(data=data, headers=headers)[0], 400)

    def test_body_and_content_type_are_bounded(self):
        data, headers = self.fixture()
        data["marker"] = "x" * 1024
        self.assertEqual(self.request(data=data, headers=headers)[0], 413)
        data, headers = self.fixture()
        headers["Content-Type"] = "text/plain"
        self.assertEqual(self.request(data=data, headers=headers)[0], 415)
        headers["Transfer-Encoding"] = "chunked"
        self.assertEqual(self.request(data=data, headers=headers)[0], 400)

    def test_missing_nonce_and_wrong_idempotency_header(self):
        data, headers = self.fixture()
        del headers["X-Request-Nonce"]
        self.assertEqual(self.request(data=data, headers=headers)[0], 400)
        data, headers = self.fixture()
        headers["Idempotency-Key"] = "wrong"
        result = self.request(data=data, headers=headers)
        self.assertFalse(result[2]["idempotencyHeaderReceived"])

    def test_expiration_and_rate_limit(self):
        now = [0]
        state = ProbeState(clock=lambda: now[0])
        for _ in range(MAX_REQUESTS):
            self.assertEqual(state.admit(), 200)
        self.assertEqual(state.admit(), 429)
        now[0] = 61
        self.assertEqual(state.admit(), 200)
        now[0] = 3600
        self.assertEqual(state.admit(), 410)

    def test_only_configured_proxy_peer_is_accepted(self):
        self.assertTrue(self.server.verify_request(None, ("127.0.0.1", 123)))
        self.assertFalse(self.server.verify_request(None, ("192.0.2.1", 123)))


if __name__ == "__main__":
    unittest.main()
