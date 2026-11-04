import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ENTRY = Path(__file__).resolve().parent / "muse"
KEY = "test-key-do-not-print"
PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000")


class FakeMeta(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        server = self.server
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        server.calls.append({"path": self.path, "auth": self.headers["Authorization"], "body": body})
        if self.path.endswith("/chat/completions") and server.delay:
            time.sleep(server.delay)
        # An optional third value declares a longer body than is sent, so the read ends early as on a dropped line.
        missing = (404, {"error": {"message": "nope"}})
        status, answer, *declared = server.answers.get(self.path.rsplit("/", 1)[-1], missing)
        if 300 <= status < 400:
            self.send_response(status)
            self.send_header("Location", answer)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        payload = answer if isinstance(answer, bytes) else json.dumps(answer).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(declared[0] if declared else len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class Elsewhere(BaseHTTPRequestHandler):
    """Another host. It must never see a request, and above all never the key."""

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.calls.append({"path": self.path, "auth": self.headers["Authorization"]})
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_POST = do_GET


def completion(content, finish="stop", prompt=1000, output=200):
    return {"id": "req-1", "model": "muse-spark-1.3", "choices": [{"finish_reason": finish, "message": {"role": "assistant", "content": content}}],
            "usage": {"prompt_tokens": prompt, "completion_tokens": output}}


def load_muse():
    spec = importlib.util.spec_from_file_location("muse_under_test", ENTRY.parent / "muse.py")
    muse = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(muse)
    return muse


class MuseCliTest(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeMeta)
        self.server.calls, self.server.delay = [], 0
        self.server.answers = {"input_tokens": (200, {"object": "response.input_tokens", "input_tokens": 1000}),
                               "completions": (200, completion("Hello from Muse"))}
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.tmp = Path(tempfile.mkdtemp())
        self.ledger = self.tmp / "ledger.jsonl"
        self.env = {**os.environ, "META_API_KEY": KEY, "AMUSEME_MUSE_API": f"http://127.0.0.1:{self.server.server_port}/v1",
                    "AMUSEME_MUSE_LEDGER": str(self.ledger), "AMUSEME_MUSE_BUDGET_USD": "1"}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def run_cli(self, *args, env=None):
        result = subprocess.run([sys.executable, str(ENTRY), *args], capture_output=True, text=True, env=env or self.env, timeout=30)
        self.assertNotIn(KEY, result.stdout + result.stderr)
        self.assertEqual(result.stderr, "")  # one JSON document on stdout, never a traceback
        return result.returncode, json.loads(result.stdout)

    def ledger_entries(self):
        return [json.loads(line) for line in self.ledger.read_text().splitlines()] if self.ledger.exists() else []

    def test_ask_counts_first_then_sends_and_records_actual_cost(self):
        image = self.tmp / "page.png"
        image.write_bytes(PNG)
        code, out = self.run_cli("ask", "--prompt", "Describe it", "--system", "Be brief", "--image", str(image), "--reasoning", "high", "--label", "t")
        self.assertEqual(code, 0, out)
        self.assertEqual(out["text"], "Hello from Muse")
        self.assertEqual([call["path"] for call in self.server.calls], ["/v1/responses/input_tokens", "/v1/chat/completions"])
        self.assertTrue(all(call["auth"] == f"Bearer {KEY}" for call in self.server.calls))
        chat = self.server.calls[1]["body"]
        self.assertEqual((chat["model"], chat["reasoning_effort"], chat["max_completion_tokens"]), ("muse-spark-1.3", "high", 4096))
        self.assertEqual(chat["messages"][0], {"role": "system", "content": "Be brief"})
        self.assertTrue(chat["messages"][1]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,"))
        self.assertEqual(self.server.calls[0]["body"]["instructions"], "Be brief")
        self.assertEqual(out["cost_usd"], 0.00210)  # 1000 * 1.25 + 200 * 4.25 per million
        [entry] = self.ledger_entries()
        self.assertEqual((entry["status"], entry["label"], entry["cost_usd"]), ("ok", "t", 0.0021))
        self.assertNotIn("Describe it", self.ledger.read_text())

    def test_wonder_takes_audio_and_video_and_prices_video_at_its_bound(self):
        audio, video = self.tmp / "line.wav", self.tmp / "film.mp4"
        audio.write_bytes(b"RIFF....WAVE")
        video.write_bytes(b"....ftypmp42")
        code, out = self.run_cli("ask", "--model", "muse-wonder-1.0", "--prompt", "Judge it", "--audio", str(audio), "--video", str(video),
                                 "--video-token-bound", "20000", "--max-output-tokens", "1000", "--max-usd", "1")
        self.assertEqual(code, 0, out)
        count, chat = (call["body"] for call in self.server.calls)
        self.assertEqual([part["type"] for part in count["input"][0]["content"]], ["input_text", "input_audio"])
        self.assertEqual([part["type"] for part in chat["messages"][0]["content"]], ["text", "input_audio", "video_url"])
        self.assertTrue(chat["messages"][0]["content"][2]["video_url"]["url"].startswith("data:video/mp4;base64,"))
        self.assertEqual(out["worst_case_usd"], 0.104)  # (1000 + 20000) * 4 + 1000 * 20 per million
        self.assertEqual(out["cost_usd"], 0.008)  # 1000 * 4 + 200 * 20 per million
        code, out = self.run_cli("ask", "--prompt", "x", "--audio", str(audio))
        self.assertEqual((code, out["error"]["code"]), (1, "bad_input"))

    def test_call_cap_refuses_before_sending(self):
        self.server.answers["input_tokens"] = (200, {"object": "response.input_tokens", "input_tokens": 400_000})
        code, out = self.run_cli("ask", "--prompt", "x")
        self.assertEqual((code, out["error"]["code"]), (1, "over_call_cap"))
        self.assertEqual(len(self.server.calls), 1)
        self.assertEqual(self.ledger_entries(), [])

    def test_budget_counts_earlier_spending(self):
        self.ledger.write_text(json.dumps({"status": "ok", "cost_usd": 0.99}) + "\n")
        code, out = self.run_cli("ask", "--prompt", "x")
        self.assertEqual((code, out["error"]["code"]), (1, "over_budget"))
        self.assertEqual(len(self.server.calls), 1)

    def test_budgets_must_be_finite_dollar_amounts(self):
        # A NaN limit makes every comparison false, so the guard would never refuse.
        for budget in ("nan", "inf", "-1", "lots"):
            with self.subTest(budget=budget):
                code, out = self.run_cli("ask", "--prompt", "x", env={**self.env, "AMUSEME_MUSE_BUDGET_USD": budget})
                self.assertEqual((code, out["error"]["code"]), (1, "bad_budget"))
        for cap in ("nan", "inf", "-1"):
            with self.subTest(cap=cap):
                code, out = self.run_cli("ask", "--prompt", "x", "--max-usd", cap)
                self.assertEqual((code, out["error"]["code"]), (1, "bad_usage"))
        self.assertEqual(self.server.calls, [])
        self.assertEqual(self.ledger_entries(), [])

    def test_schema_answers_are_parsed_and_saved(self):
        schema = self.tmp / "video-script.json"
        schema.write_text(json.dumps({"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"], "additionalProperties": False}))
        self.server.answers["completions"] = (200, completion(json.dumps({"title": "AmuseMe"})))
        out_file = self.tmp / "out" / "script.json"
        code, out = self.run_cli("ask", "--prompt", "x", "--schema", str(schema), "--out", str(out_file))
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads(out_file.read_text()), {"title": "AmuseMe"})
        chat = self.server.calls[1]["body"]
        self.assertEqual(chat["response_format"]["json_schema"]["name"], "video_script")
        self.assertEqual(self.server.calls[0]["body"]["text"]["format"]["type"], "json_schema")

    def test_invalid_json_and_truncation_fail_but_still_record_cost(self):
        schema = self.tmp / "s.json"
        schema.write_text("{}")
        self.server.answers["completions"] = (200, completion("not json"))
        code, out = self.run_cli("ask", "--prompt", "x", "--schema", str(schema))
        self.assertEqual((code, out["error"]["code"]), (1, "bad_json"))
        self.server.answers["completions"] = (200, completion("cut", finish="length"))
        code, out = self.run_cli("ask", "--prompt", "x")
        self.assertEqual((code, out["error"]["code"], out["error"]["partial"]), (1, "truncated", "cut"))
        self.assertEqual([entry["status"] for entry in self.ledger_entries()], ["ok", "ok"])

    def test_unanswered_request_is_charged_at_its_worst_case(self):
        self.server.delay = 3
        code, out = self.run_cli("ask", "--prompt", "x", "--timeout", "1")
        self.assertEqual((code, out["error"]["code"]), (1, "unreachable"))
        [entry] = self.ledger_entries()
        self.assertEqual((entry["status"], entry["cost_usd"]), ("unknown", entry["worst_case_usd"]))

    def test_an_unreadable_answer_is_charged_at_its_worst_case(self):
        # Meta answered 2xx, so it did the work; with no readable usage the reservation is the honest charge.
        for label, body in (("not JSON", b"<html>busy</html>"), ("not UTF-8", b"\x80\x81"),
                            ("not an object", b"[1, 2]")):
            with self.subTest(label):
                self.server.answers["completions"] = (200, body)
                code, out = self.run_cli("ask", "--prompt", "x")
                self.assertEqual((code, out["error"]["code"]), (1, "bad_response"))
                entry = self.ledger_entries()[-1]
                self.assertEqual((entry["status"], entry["cost_usd"]), ("unknown", entry["worst_case_usd"]))
        self.assertEqual(len(self.ledger_entries()), 3)

    def test_an_answer_cut_off_mid_read_is_charged_at_its_worst_case(self):
        # The request reached Meta either way, so a body that stops early, even on a 5xx, is billed at the reservation.
        answer = json.dumps(completion("Hello")).encode()
        for label, status, body, code in (("cut-off 200", 200, answer, "bad_response"),
                                          ("cut-off 500", 500, b'{"error": {"message": "overloaded"}}', "http_500")):
            with self.subTest(label):
                self.server.answers["completions"] = (status, body[:-10], len(body))
                result, out = self.run_cli("ask", "--prompt", "x")
                self.assertEqual((result, out["error"]["code"]), (1, code))
                entry = self.ledger_entries()[-1]
                self.assertEqual((entry["status"], entry["cost_usd"]), ("unknown", entry["worst_case_usd"]))
        self.assertEqual(len(self.ledger_entries()), 2)

    def test_an_unforeseen_fault_in_the_call_is_still_charged(self):
        muse = load_muse()

        def post(path, body, key, timeout):
            if path.endswith("/chat/completions"):
                raise RuntimeError(f"detail that might hold {KEY}")
            return {"input_tokens": 1000}
        stdout = io.StringIO()
        with (mock.patch.dict(os.environ, self.env), mock.patch.object(muse, "post", post),
              contextlib.redirect_stdout(stdout)):
            code = muse.main(["ask", "--prompt", "x"])
        self.assertEqual((code, json.loads(stdout.getvalue())["error"]),
                         (1, {"code": "internal", "message": "Unexpected RuntimeError"}))
        [entry] = self.ledger_entries()
        self.assertEqual((entry["status"], entry["cost_usd"]), ("unknown", entry["worst_case_usd"]))

    def test_a_malformed_answer_is_recorded_before_it_is_read(self):
        self.server.answers["completions"] = (200, {**completion("x"), "choices": "oops"})
        code, out = self.run_cli("ask", "--prompt", "x")
        self.assertEqual((code, out["error"]["code"], out["error"]["cost_usd"]), (1, "bad_response", 0.0021))
        self.server.answers["completions"] = (200, {**completion("fine"), "usage": [1]})
        code, out = self.run_cli("ask", "--prompt", "x")
        self.assertEqual((code, out["text"], out["cost_usd"]), (0, "fine", out["worst_case_usd"]))
        self.assertEqual([(entry["status"], entry["cost_usd"]) for entry in self.ledger_entries()],
                         [("ok", 0.0021), ("ok", out["worst_case_usd"])])

    def test_usage_counts_must_be_whole_and_not_negative(self):
        # True is an int to Python, and a negative count would book a refund; neither measures the call.
        for label, prompt, output in (("boolean", True, 200), ("negative", 1000, -1), ("fractional", 1000.0, 200)):
            with self.subTest(label):
                self.server.answers["completions"] = (200, completion("fine", prompt=prompt, output=output))
                code, out = self.run_cli("ask", "--prompt", "x")
                self.assertEqual((code, out["cost_usd"]), (0, out["worst_case_usd"]))
                self.assertEqual(self.ledger_entries()[-1]["cost_usd"], out["worst_case_usd"])
        for label, tokens in (("boolean", True), ("negative", -5)):
            with self.subTest(f"{label} input count"):
                self.server.answers["input_tokens"] = (200, {"input_tokens": tokens})
                code, out = self.run_cli("ask", "--prompt", "x")
                self.assertEqual((code, out["error"]["code"]), (1, "bad_response"))
        self.assertEqual(len(self.ledger_entries()), 3)

    def test_client_errors_are_not_charged_and_hide_the_key(self):
        self.server.answers["completions"] = (400, {"error": {"message": f"bad request for {KEY}"}})
        code, out = self.run_cli("ask", "--prompt", "x")
        self.assertEqual((code, out["error"]["code"]), (1, "http_400"))
        self.assertIn("<key>", out["error"]["api_message"])
        self.assertEqual(self.ledger_entries()[0]["cost_usd"], 0.0)

    def test_the_key_is_redacted_before_the_message_is_shortened(self):
        self.server.answers["completions"] = (400, {"error": {"message": "x" * 1990 + KEY + " tail"}})
        code, out = self.run_cli("ask", "--prompt", "x")
        self.assertEqual((code, out["error"]["api_message"]), (1, "x" * 1990 + "<key> tail"))

    def test_key_from_env_file_and_api_host_restriction(self):
        env_file = self.tmp / "private.env"
        env_file.write_text(f'OTHER=1\nMETA_API_KEY="{KEY}"\n')
        env = {key: value for key, value in self.env.items() if key != "META_API_KEY"}
        code, out = self.run_cli("--env-file", str(env_file), "check", env=env)
        self.assertEqual((code, out["authenticated"]), (0, True))
        code, out = self.run_cli("check", env={**self.env, "AMUSEME_MUSE_API": "https://example.com/v1"})
        self.assertEqual((code, out["error"]["code"]), (1, "bad_api"))
        code, out = self.run_cli("check", env=env)
        self.assertEqual((code, out["error"]["code"]), (1, "no_key"))

    def test_redirects_are_refused_so_the_key_never_leaves(self):
        elsewhere = ThreadingHTTPServer(("127.0.0.1", 0), Elsewhere)
        elsewhere.calls = []
        threading.Thread(target=elsewhere.serve_forever, daemon=True).start()
        self.addCleanup(elsewhere.server_close)
        self.addCleanup(elsewhere.shutdown)
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                self.server.answers["completions"] = (status, f"http://localhost:{elsewhere.server_port}/steal")
                code, out = self.run_cli("ask", "--prompt", "x")
                self.assertEqual(elsewhere.calls, [])
                self.assertEqual((code, out["error"]["code"], out["error"]["status"]), (1, "redirected", status))
                # Meta may have done the work before redirecting, so the call counts at its worst case.
                entry = self.ledger_entries()[-1]
                self.assertEqual((entry["status"], entry["cost_usd"]), ("unknown", entry["worst_case_usd"]))
        self.server.answers["input_tokens"] = (303, f"http://localhost:{elsewhere.server_port}/steal")
        code, out = self.run_cli("check")
        self.assertEqual((code, out["error"]["code"]), (1, "redirected"))
        self.assertEqual(elsewhere.calls, [])

    def test_every_failure_is_one_json_document(self):
        schema, absent = self.tmp / "broken.json", self.tmp / "absent"
        schema.write_text("{not json")
        wonder = ("--model", "muse-wonder-1.0", "--prompt", "x")
        for label, args, error in (
            ("missing prompt file", ("ask", "--prompt-file", str(absent)), "bad_input"),
            ("prompt file is a folder", ("count", "--prompt-file", str(self.tmp)), "bad_input"),
            ("missing image", ("count", "--prompt", "x", "--image", f"{absent}.png"), "bad_image"),
            ("missing audio", ("count", *wonder, "--audio", f"{absent}.wav"), "bad_media"),
            ("missing video", ("count", *wonder, "--video", f"{absent}.mp4"), "bad_media"),
            ("schema is not JSON", ("count", "--prompt", "x", "--schema", str(schema)), "bad_input"),
            ("missing schema", ("count", "--prompt", "x", "--schema", str(absent)), "bad_input"),
            ("unknown option", ("ask", "--prompt", "x", "--bogus"), "bad_usage"),
            ("no command", (), "bad_usage"),
            ("not a number", ("ask", "--prompt", "x", "--max-usd", "lots"), "bad_usage"),
        ):
            with self.subTest(label):
                code, out = self.run_cli(*args)
                self.assertEqual((code, out["ok"], out["error"]["code"]), (1, False, error))
        self.assertEqual(self.server.calls, [])

    def test_a_malformed_ledger_is_reported_not_summed(self):
        for label, line in (("not JSON", "{oops"), ("not an object", "[1]"), ("no cost", '{"status": "ok"}'),
                            ("cost is text", '{"cost_usd": "0.1"}'), ("cost is NaN", '{"cost_usd": NaN}'),
                            ("cost is negative", '{"cost_usd": -5}')):
            with self.subTest(label):
                self.ledger.write_text(json.dumps({"status": "ok", "cost_usd": 0.1}) + "\n" + line + "\n")
                code, out = self.run_cli("spend")
                self.assertEqual((code, out["error"]["code"]), (1, "bad_ledger"))
                self.assertIn("line 2", out["error"]["message"])
                code, out = self.run_cli("ask", "--prompt", "x")
                self.assertEqual((code, out["error"]["code"]), (1, "bad_ledger"))
        self.assertNotIn("/v1/chat/completions", [call["path"] for call in self.server.calls])

    def test_an_unforeseen_fault_is_still_json_and_carries_no_detail(self):
        muse = load_muse()

        def fault(args):
            raise RuntimeError(f"detail that might hold {KEY}")
        stdout = io.StringIO()
        with mock.patch.dict(muse.COMMANDS, {"spend": fault}), contextlib.redirect_stdout(stdout):
            code = muse.main(["spend"])
        self.assertEqual((code, json.loads(stdout.getvalue())["error"]),
                         (1, {"code": "internal", "message": "Unexpected RuntimeError"}))
        self.assertNotIn(KEY, stdout.getvalue())

    def test_spend_sums_the_ledger(self):
        self.ledger.write_text("\n".join(json.dumps(entry) for entry in [{"status": "ok", "cost_usd": 0.1}, {"status": "unknown", "cost_usd": 0.2}]) + "\n")
        code, out = self.run_cli("spend")
        self.assertEqual((code, out["calls"], out["unknown_calls"], out["spent_usd"], out["remaining_usd"]), (0, 2, 1, 0.3, 0.7))


if __name__ == "__main__":
    unittest.main()
