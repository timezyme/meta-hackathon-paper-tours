# Muse CLI

Call Meta's Muse models at `api.meta.ai` from the command line, outside the document pipeline:
- `muse-spark-1.3` is the default. It reads text and images.
- `muse-wonder-1.0` (`--model muse-wonder-1.0`) also hears audio (`--audio`, WAV or MP3) and watches video (`--video`, MP4 sent as a data URL). For example, it can check a narration line or review a finished video. Every command prints one JSON document: `{"ok": true, ...}` or `{"ok": false, "error": {"code", "message", ...}}`, and exits 1 on failure.

Run from the repository root:

```sh
./cli/muse/muse --env-file <private env> check            # proves the key works with a token count; generates nothing
./cli/muse/muse --env-file <private env> count --prompt "..." --image page.png
./cli/muse/muse --env-file <private env> ask --prompt "..." [--system "..."] [--image a.png ...] \
    [--schema answer.json] [--reasoning low|medium|high] [--max-output-tokens 4096] [--max-usd 0.25] [--label note] [--out file]
./cli/muse/muse spend                                     # spending recorded in the ledger
```

The key comes from `META_API_KEY`, or from the `META_API_KEY` line of `--env-file`. It is never printed or written to the ledger. Use `--prompt -` to read the prompt from stdin, and `--prompt-file`/`--system-file` for long text. `--schema` takes a strict JSON Schema; the answer is parsed and returned as `json`.

## Cost control

Before sending, `ask` counts the input tokens and prices the worst case.
- **Spark rates:** the pipeline's, $1.25 per million input tokens and $4.25 per million output tokens (see `metaRates` in `src/processing/config.ts`).
- **Wonder rates:** $4 and $20 per million, taken from third-party listings, not a Meta price sheet.
- **Video:** the count endpoint rejects video, so each video is priced at `--video-token-bound` input tokens (default 100,000). A 6-second 640-pixel clip used about 530 tokens. With the default bound, a video call's worst case exceeds the default `--max-usd 0.25`, so pass a lower bound or a higher cap.
- **Per call:** it refuses when the worst case is above `--max-usd`.
- **Budget:** it refuses when the worst case would take the ledger past `AMUSEME_MUSE_BUDGET_USD` (default $5).
- **Ledger:** every call is recorded in `AMUSEME_MUSE_LEDGER` (default `qa/muse/ledger.jsonl`, which git ignores). Each entry holds token counts, cost, label and a request hash, never the prompt.
- **Unclear outcomes:** a call whose outcome is unknown (timeout, network failure or 5xx) is recorded at its worst case.

This budget is separate from the processing budget in `provider_charges`.

Reasoning uses output tokens, so leave room. A one-sentence answer used about 700 output tokens at `--reasoning low`, and a 512-token cap was not enough. `truncated` means the cap was hit; the partial text is included and the call is still charged.

Run the offline tests. They use a local fake server and never reach Meta:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s cli/muse -p 'test_*.py' -v
```
