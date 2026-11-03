from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

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
        status, answer = server.answers.get(self.path.rsplit("/", 1)[-1], (404, {"error": {"message": "nope"}}))
        payload = json.dumps(answer).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def completion(content, finish="stop", prompt=1000, output=200):
    return {"id": "req-1", "model": "muse-spark-1.3", "choices": [{"finish_reason": finish, "message": {"role": "assistant", "content": content}}],
            "usage": {"prompt_tokens": prompt, "completion_tokens": output}}


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

    def test_client_errors_are_not_charged_and_hide_the_key(self):
        self.server.answers["completions"] = (400, {"error": {"message": f"bad request for {KEY}"}})
        code, out = self.run_cli("ask", "--prompt", "x")
        self.assertEqual((code, out["error"]["code"]), (1, "http_400"))
        self.assertIn("<key>", out["error"]["api_message"])
        self.assertEqual(self.ledger_entries()[0]["cost_usd"], 0.0)

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

    def test_spend_sums_the_ledger(self):
        self.ledger.write_text("\n".join(json.dumps(entry) for entry in [{"status": "ok", "cost_usd": 0.1}, {"status": "unknown", "cost_usd": 0.2}]) + "\n")
        code, out = self.run_cli("spend")
        self.assertEqual((code, out["calls"], out["unknown_calls"], out["spent_usd"], out["remaining_usd"]), (0, 2, 1, 0.3, 0.7))


if __name__ == "__main__":
    unittest.main()
