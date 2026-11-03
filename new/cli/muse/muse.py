#!/usr/bin/env python3
"""Call Meta Muse models with a cost check before every call. Prints one JSON document per command."""

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[2]
MODEL = "muse-spark-1.3"
API = "https://api.meta.ai/v1"
# USD per million (input, output) tokens. Spark matches metaRates in src/processing/config.ts.
# Wonder uses published third-party prices ($4 / $20), not a Meta price sheet.
RATES = {"muse-spark-1.3": (1.25, 4.25), "muse-wonder-1.0": (4.00, 20.00)}
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
AUDIO_TYPES = {".wav": "wav", ".mp3": "mp3"}
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_MEDIA_BYTES = 40 * 1024 * 1024
DEFAULT_LEDGER = ROOT / "qa/muse/ledger.jsonl"
DEFAULT_BUDGET_USD = 5.0


class Failure(Exception):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code = code
        self.details = details


def api_base():
    base = os.environ.get("AMUSEME_MUSE_API", API).rstrip("/")
    parsed = urlparse(base)
    # The key is sent to this host, so only Meta itself or a local test server qualifies.
    if base != API and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")):
        raise Failure("bad_api", "AMUSEME_MUSE_API may only point at a loopback test server")
    return base


def api_key(env_file):
    if env_file:
        path = Path(env_file).expanduser()
        if not path.is_file():
            raise Failure("no_key", f"{path} does not exist")
        for line in path.read_text().splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "META_API_KEY" and value.strip():
                return value.strip().strip('"').strip("'")
        raise Failure("no_key", f"{path} has no META_API_KEY line")
    key = os.environ.get("META_API_KEY", "").strip()
    if not key:
        raise Failure("no_key", "Set META_API_KEY or pass --env-file with a META_API_KEY line")
    return key


def read_text(inline, file, label, required):
    if inline is not None and file is not None:
        raise Failure("bad_input", f"Pass --{label} or --{label}-file, not both")
    if file is not None:
        return Path(file).read_text()
    if inline == "-":
        return sys.stdin.read()
    if inline is None and required:
        raise Failure("bad_input", f"--{label} or --{label}-file is required")
    return inline


def image_url(path):
    path = Path(path)
    kind = IMAGE_TYPES.get(path.suffix.lower())
    if kind is None:
        raise Failure("bad_image", f"{path.name}: use PNG, JPEG or WebP")
    data = path.read_bytes()
    if len(data) > MAX_IMAGE_BYTES:
        raise Failure("bad_image", f"{path.name} is larger than {MAX_IMAGE_BYTES // (1024 * 1024)} MB")
    return f"data:{kind};base64,{base64.b64encode(data).decode()}"


def media(path, types, label):
    path = Path(path)
    kind = types.get(path.suffix.lower())
    if kind is None:
        raise Failure("bad_media", f"{path.name}: use {', '.join(sorted(types))} for --{label}")
    data = path.read_bytes()
    if len(data) > MAX_MEDIA_BYTES:
        raise Failure("bad_media", f"{path.name} is larger than {MAX_MEDIA_BYTES // (1024 * 1024)} MB; downscale it first")
    return kind, base64.b64encode(data).decode()


def build_request(args):
    if (args.audio or args.video) and args.model != "muse-wonder-1.0":
        raise Failure("bad_input", "Only muse-wonder-1.0 accepts --audio and --video")
    prompt = read_text(args.prompt, args.prompt_file, "prompt", required=True)
    system = read_text(args.system, args.system_file, "system", required=False)
    images = [image_url(path) for path in args.image]
    audio = [media(path, AUDIO_TYPES, "audio") for path in args.audio]
    video = [media(path, {".mp4": "mp4"}, "video")[1] for path in args.video]
    schema = json.loads(Path(args.schema).read_text()) if args.schema else None
    messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": [
        {"type": "text", "text": prompt}, *({"type": "image_url", "image_url": {"url": url}} for url in images),
        *({"type": "input_audio", "input_audio": {"data": data, "format": kind}} for kind, data in audio),
        *({"type": "video_url", "video_url": {"url": f"data:video/mp4;base64,{data}"}} for data in video)]}]
    chat = {"model": args.model, "messages": messages, "reasoning_effort": args.reasoning, "max_completion_tokens": args.max_output_tokens}
    # The token-count endpoint rejects video, so videos are left out of the count and priced at --video-token-bound each.
    count = {"model": args.model, "input": [{"role": "user", "content": [
        {"type": "input_text", "text": prompt}, *({"type": "input_image", "image_url": url} for url in images),
        *({"type": "input_audio", "input_audio": {"data": data, "format": kind}} for kind, data in audio)]}],
        "reasoning": {"effort": args.reasoning}}
    if system:
        count["instructions"] = system
    if schema is not None:
        format = {"name": Path(args.schema).stem.replace("-", "_"), "strict": True, "schema": schema}
        chat["response_format"] = {"type": "json_schema", "json_schema": format}
        count["text"] = {"format": {"type": "json_schema", **format}}
    fingerprint = hashlib.sha256(json.dumps(chat, sort_keys=True).encode()).hexdigest()
    return chat, count, fingerprint


def post(path, body, key, timeout):
    request = Request(f"{api_base()}{path}", data=json.dumps(body).encode(), method="POST",
                      headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except HTTPError as error:
        text = error.read().decode("utf-8", "replace")
        try:
            message = json.loads(text).get("error", {}).get("message") or text
        except (json.JSONDecodeError, AttributeError):
            message = text
        raise Failure(f"http_{error.code}", f"Meta API returned {error.code}", api_message=message[:2000].replace(key, "<key>")) from None
    except (URLError, TimeoutError, OSError) as error:
        raise Failure("unreachable", f"Meta API did not answer: {type(error).__name__}") from None
    except json.JSONDecodeError:
        raise Failure("bad_response", "Meta API answered with something other than JSON") from None


def usd(model, input_tokens, output_tokens):
    input_rate, output_rate = RATES[model]
    return round((input_tokens * input_rate + output_tokens * output_rate) / 1_000_000, 6)


def input_bound(args, count, key):
    return count_tokens(count, key) + len(args.video) * args.video_token_bound


def ledger_path():
    return Path(os.environ.get("AMUSEME_MUSE_LEDGER", DEFAULT_LEDGER)).expanduser()


def budget_usd():
    return float(os.environ.get("AMUSEME_MUSE_BUDGET_USD", DEFAULT_BUDGET_USD))


def spent_usd():
    path = ledger_path()
    if not path.is_file():
        return 0.0
    return round(sum(json.loads(line)["cost_usd"] for line in path.read_text().splitlines() if line.strip()), 6)


def record(entry):
    path = ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as ledger:
        ledger.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **entry}) + "\n")


def count_tokens(count, key):
    answer = post("/responses/input_tokens", count, key, timeout=60)
    tokens = answer.get("input_tokens") if isinstance(answer, dict) else None
    if not isinstance(tokens, int) or tokens <= 0:
        raise Failure("bad_response", "The token count answer had no input_tokens")
    return tokens


def cmd_check(args):
    key = api_key(args.env_file)
    tokens = count_tokens({"model": MODEL, "input": [{"role": "user", "content": [{"type": "input_text", "text": "ping"}]}]}, key)
    return {"model": MODEL, "authenticated": True, "probe_input_tokens": tokens, "spent_usd": spent_usd(), "budget_usd": budget_usd()}


def cmd_count(args):
    key = api_key(args.env_file)
    _, count, _ = build_request(args)
    tokens = input_bound(args, count, key)
    return {"model": args.model, "input_tokens": tokens, "max_output_tokens": args.max_output_tokens,
            "worst_case_usd": usd(args.model, tokens, args.max_output_tokens)}


def cmd_ask(args):
    key = api_key(args.env_file)
    chat, count, fingerprint = build_request(args)
    tokens = input_bound(args, count, key)
    worst = usd(args.model, tokens, args.max_output_tokens)
    spent, budget = spent_usd(), budget_usd()
    if worst > args.max_usd:
        raise Failure("over_call_cap", f"Worst case ${worst} is above --max-usd ${args.max_usd}", input_tokens=tokens)
    if spent + worst > budget:
        raise Failure("over_budget", f"Worst case ${worst} would take spending past the ${budget} budget", spent_usd=spent, ledger=str(ledger_path()))
    base = {"command": "ask", "model": args.model, "label": args.label, "request_sha256": fingerprint, "input_tokens_bound": tokens, "worst_case_usd": worst}
    try:
        answer = post("/chat/completions", chat, key, timeout=args.timeout)
    except Failure as error:
        # A request that may have reached Meta counts at its worst case, so the budget never under-reports.
        sent = error.code == "unreachable" or error.code.startswith("http_5")
        record({**base, "status": "unknown" if sent else "failed", "cost_usd": worst if sent else 0.0})
        raise
    usage = answer.get("usage") or {}
    input_tokens, output_tokens = usage.get("prompt_tokens"), usage.get("completion_tokens")
    cost = usd(args.model, input_tokens, output_tokens) if isinstance(input_tokens, int) and isinstance(output_tokens, int) else worst
    choice = (answer.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    record({**base, "status": "ok", "request_id": answer.get("id"), "input_tokens": input_tokens, "output_tokens": output_tokens, "cost_usd": cost})
    result = {"model": answer.get("model", args.model), "finish_reason": choice.get("finish_reason"),
              "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens}, "cost_usd": cost,
              "worst_case_usd": worst, "spent_usd": spent_usd(), "budget_usd": budget}
    if message.get("refusal"):
        raise Failure("refused", "Muse refused the request", refusal=message["refusal"], **result)
    text = message.get("content") or ""
    if choice.get("finish_reason") == "length":
        raise Failure("truncated", "The answer hit --max-output-tokens before it finished", partial=text, **result)
    if args.schema:
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            raise Failure("bad_json", "The answer was not valid JSON for the schema", text=text, **result) from None
        content = {"json": value}
    else:
        content = {"text": text}
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(content["json"], indent=2) + "\n" if args.schema else text)
        return {**result, "out": str(out)}
    return {**result, **content}


def cmd_spend(args):
    path = ledger_path()
    entries = [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.is_file() else []
    return {"ledger": str(path), "calls": len(entries), "unknown_calls": sum(entry["status"] == "unknown" for entry in entries),
            "spent_usd": spent_usd(), "budget_usd": budget_usd(), "remaining_usd": round(budget_usd() - spent_usd(), 6)}


def add_request_options(command):
    command.add_argument("--model", choices=sorted(RATES), default=MODEL, help="muse-wonder-1.0 also hears audio and watches video")
    command.add_argument("--prompt", help="prompt text, or - to read stdin")
    command.add_argument("--prompt-file")
    command.add_argument("--system", help="system instructions")
    command.add_argument("--system-file")
    command.add_argument("--image", action="append", default=[], help="PNG, JPEG or WebP to attach (repeatable)")
    command.add_argument("--audio", action="append", default=[], help="WAV or MP3 to attach (repeatable; muse-wonder-1.0 only)")
    command.add_argument("--video", action="append", default=[], help="MP4 to attach (repeatable; muse-wonder-1.0 only)")
    command.add_argument("--video-token-bound", type=int, default=100_000, help="input tokens assumed per video, which the count endpoint can't measure")
    command.add_argument("--schema", help="JSON Schema file; the answer must match it (strict)")
    command.add_argument("--reasoning", choices=("low", "medium", "high"), default="medium")
    command.add_argument("--max-output-tokens", type=int, default=4096)


def parser():
    root = argparse.ArgumentParser(prog="muse", description=__doc__)
    root.add_argument("--env-file", help="read META_API_KEY from this dotenv file instead of the environment")
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("check", help="prove the key works with a token count; generates nothing")
    count = commands.add_parser("count", help="count input tokens and price the worst case; generates nothing")
    add_request_options(count)
    ask = commands.add_parser("ask", help="send a prompt (and images) to Muse Spark")
    add_request_options(ask)
    ask.add_argument("--max-usd", type=float, default=0.25, help="refuse when this call's worst case is higher")
    ask.add_argument("--timeout", type=int, default=600, help="seconds to wait for the answer")
    ask.add_argument("--label", help="short note saved in the ledger, e.g. video-script")
    ask.add_argument("--out", help="write the answer here instead of printing it")
    commands.add_parser("spend", help="total spending recorded in the ledger")
    return root


COMMANDS = {"check": cmd_check, "count": cmd_count, "ask": cmd_ask, "spend": cmd_spend}


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        envelope = {"ok": True, "command": args.command, **COMMANDS[args.command](args)}
    except Failure as error:
        envelope = {"ok": False, "command": args.command, "error": {"code": error.code, "message": str(error), **error.details}}
    print(json.dumps(envelope, indent=2))
    return 0 if envelope["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
