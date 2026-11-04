# Local application operations

This runbook describes the single-host application. By default it binds **127.0.0.1** and accepts a canonical `http://127.0.0.1:<port>` or `http://localhost:<port>` origin with the same port. The judge deployment behind Modal's HTTPS proxy is described in [Modal judge deployment](modal-deploy.md). Normal model processing is Meta-only. Historical MinerU service operations remain in the [MinerU/Modal runbook](mineru-modal.md).

## Prepare and start

Use the pinned Node 24.19.0, pnpm 10.33.0 and isolated Python/PyMuPDF environment from [local setup](https://github.com/timezyme/meta-hackathon-paper-tours#run-it) and [Python setup](../../python/README.md). Run from the intended checkout. Before changing the serving build, record its revision or file hashes, launch command, origin, absolute data/Python paths and non-secret configuration. Keep credential values private.

| Setting | Operational requirement |
|---|---|
| `AMUSEME_PORT`, `AMUSEME_ORIGIN` | Default port 4180; the explicit origin must match. Use the actual configured port for browser and health checks. |
| `AMUSEME_DATA_DIR` | Private owned local directory, mode 0700. Defaults to `data`; resolve and record its absolute path. Preserve this same directory across restarts. |
| `BETTER_AUTH_SECRET` | Private random value of at least 32 characters. Preserve the configured value during routine restarts and backup recovery. |
| `AMUSEME_PYTHON_BIN` | Defaults to `data/python/.venv/bin/python` relative to the checkout, independently of `AMUSEME_DATA_DIR`. The verified interpreter is Python 3.14.5 with PyMuPDF 1.28.2. |
| `AMUSEME_PROCESSING_ENABLED` | Defaults to false. Enabling live processing requires existing authorization and all provider/budget settings below. |
| `META_API_KEY` | Required for all current model stages. Never print the credential. MinerU settings are not required for processing. |
| `AMUSEME_MINERU_URL`, `AMUSEME_MINERU_TOKEN` | Optional historical remote cleanup only. Retain existing configuration when preserving a saved document policy; do not substitute other applications’ resources. No new extraction or saved-job retrieval is dispatched through MinerU. |
| `AMUSEME_BUDGET_ID`, `AMUSEME_PROCESSING_BUDGET_USD` | Choose a stable budget identity and an allowance supported by [processing configuration](../../src/processing/config.ts). Preserve the identity and ledger across restarts. The configured ceiling is not a measured bill. |
| `AMUSEME_HOST` | `127.0.0.1` by default; `0.0.0.0` only behind a TLS-terminating proxy with an `https://` `AMUSEME_ORIGIN`. |
| `AMUSEME_TRUSTED_PROXY` | `none` by default. Set `modal` only behind Modal's HTTPS proxy, so sign-in rate limits count each client by the `X-Forwarded-For` address instead of putting every judge in one bucket. |
| `AMUSEME_JUDGE_SIGN_IN`, `AMUSEME_JUDGE_ACCESS_CODE` | Off by default. Enables email-only sign-in (user role only); the optional code is private. |
| `AMUSEME_EXAMPLES_OWNER_ID`, `AMUSEME_UPLOADS_PER_USER` | Unset by default. Share one owner's documents read-only; cap lifetime uploads per non-admin user. |
| `AMUSEME_QUEUE_LIMIT` | Defaults to 10. Up to two document runs from different owners execute at once, and only when the remaining budget covers both runs' caps. Changing queue capacity does not grant more inference allowance. |

`pnpm start` loads ignored `.env` and `.env.local`, sets the bundled Studio path and starts `dist/server.mjs`. Use this guarded entry point, never the generated Mastra CLI listener. The normal build and offline acceptance commands are:

```sh
pnpm check
pnpm test
pnpm build
pnpm start
```

Run the test/build commands in the candidate checkout before replacing a serving build. Verify the affected flow in Chrome through CUA accessibility/native controls or supported Chrome DevTools commands, or in the cmux built-in browser (WebKit) when Chrome cannot be driven. Playwright is prohibited; use the [manual verification harness](development-harness.md#verify-in-a-browser). Browser checks do not authorize real processing. For development, `pnpm dev` builds and watches the guarded server, while `pnpm dev:app` rebuilds the UI. Provision invited `user` or `admin` accounts with the existing `pnpm provision:user` command and private `AMUSEME_INVITE_*` configuration from [.env.example](../../.env.example); public signup is disabled.

Only one process may own a data directory. Startup acquires an OS lock before storage initialization and reconciliation. A busy/unsafe/unavailable lock is a stop condition. Do not delete `.amuseme-process.lock`, start a second copy, or point to empty data to evade it. The diagnostic PID in the file is not authority to remove the lock. See [process locking](../step-rules/process-lock.md).

## Readiness and inspection

Wait for `AmuseMe ready`, then check the configured origin. These default-port examples are read-only:

```sh
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:4180/health
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:4180/health/ready
```

Expect `{"status":"alive"}` and HTTP 200 with `{"status":"ready"}`. Readiness describes the listener, not provider credentials, budget availability or document accuracy. Sign in and inspect upload availability and existing document status. Incomplete live configuration disables new uploads/retries; it does not make the reader a live-processing test.

An admin may inspect stock Studio at `/admin`: registered agents, workflow definitions/runs and traces. Ordinary users cannot enter. Support APIs do not establish a separate working logs page. Generic generation, tool execution and workflow run/recovery mutations are denied; admin status does not authorize provider calls. Use the reader's report for source issues, receipts and usage; unavailable cost is not zero. See [Studio access rules](../step-rules/studio-inspection.md) and the [joint Mastra/Studio upgrade procedure](mastra-upgrade.md).

## Stop, snapshot and restart

1. For a planned stop, stop admitting new work operationally and wait for existing work to become terminal when practical. There is no drain CLI or maintenance-mode endpoint. Use Ctrl-C in the owning foreground terminal, or send SIGTERM to the positively identified application process through its supervisor. Do not use a broad process-name kill.
2. Let scoped shutdown finish. It interrupts dispatcher/maintenance work, closes the listener, drains workflow callbacks, flushes traces and closes stores. Listener close has a five-second wait before forcing connections closed; noncancelable SDK operations can extend whole-process shutdown. Check actual process exit and that the configured listener is gone before starting another instance or copying storage. Forced termination can leave completion uncertain.
3. **While the application and any provisioning/repair writer are stopped, snapshot the entire configured data directory together.** Include `application.sqlite`, `auth.sqlite`, `mastra.sqlite`, all SQLite sidecars, document sources, hash-addressed objects, raw responses, page images, uploads/processing/archive directories, tombstones, retry/cleanup records and the lock file. Keep the snapshot private. Preserve the corresponding build/dependency identities and private configuration/secrets separately with equivalent protection. Do not copy individual SQLite files from a running process or mix database and artifact snapshots from different times.
4. Never reset/delete `provider_charges`, replace the budget ID, or use a fresh data directory to regain allowance. An older backup omits later charges and attempts: restoring it is not permission to replay work. Reconcile any post-snapshot provider activity and preserve its spending/attempt records before resuming live dispatch. A local snapshot does not capture Modal state or cancel remote work. Unknown reservations remain reserved.
5. Restart through the guarded entry point with the same complete storage/configuration. Startup validates retained sources, reconciles crash leftovers and saved attempts, then reconnects eligible durable work. Do not run migrations or direct storage constructors separately against the live directory. Recheck readiness, the existing run IDs and known outputs before any newly authorized upload.

## Interrupted work and explicit retry

Read `GET /api/documents/:documentId/status` through the authenticated product session or open that document in the UI. A successful revision stays tied to its saved artifacts. Safe local work and validated saved provider responses may resume without a new remote submission. Unknown completion never grants an automatic repeated call.

Historical MinerU retrieval was authenticated **GET `/jobs/{saved-attempt-UUID}`** at the configured gateway. The retained historical adapter owns this lookup and bounded polling; the current Meta-only runtime refuses its dispatch and retrieval. Use the saved extraction UUID; do not create a new UUID or repeat POST to “recover.” A completed archive settles the same receipt. GET 404/503 remains unresolved; 410 means expired/deleted and is permanent. There is no separate operator recovery CLI. Unknown Meta completion cannot be assumed retrievable or refunded.

For an eligible terminal failure, use the product's explicit Retry action. Its existing API is `POST /api/documents/:documentId/retry`, with the current owner session, exact `Origin`, a stable `Idempotency-Key`, and JSON `{ "previousRunId": "<failed-run-id>", "acknowledgePossibleRepeatedWork": false }`. Set acknowledgment true only after the user explicitly accepts possible repeated work when required. The server validates eligibility and creates a bounded new run; it does not reset the original budget or repeat completed work blindly. Preserve the same key/body across an uncertain HTTP result and inspect status before another action. Invalid model output and permanent failures do not become retryable by changing flags. The UI already persists retry identity; do not invent a shell retry loop. See [recovery rules](../step-rules/run-recovery.md).

Changing an approved allowance or MinerU endpoint does not rewrite saved document policies. Existing outputs remain readable. Retrying an older document under a different policy is refused; do not weaken that comparison or reset its charges. A new upload binds the current approved policy and counts all earlier charges under the same budget identity.

## Retention and cleanup backlog

Document access expires seven days after admission. Owner deletion is permitted only for terminal work. Both retain spending records and durable cleanup identities. Local maintenance runs at startup and then on a scoped 60-second interval, processing bounded batches of document history and remote cleanup. Deleted/expired documents stay inaccessible if physical cleanup fails.

Inspect `Document cleanup has pending work` and `Document maintenance failed` logs. Aggregate fields distinguish `reconciliationFailed`, `localFailures`, `remotePending` and `remoteDisabled`. Repeated pending counts need investigation of the configured data directory, private filesystem access and separate gateway availability, not manual deletion of receipts. No cleanup-management CLI is implemented. Preserve tombstones/outbox rows so later passes can finish.

Remote DELETE clears an outbox row only after 204/404; 409, 410 and unknown/error outcomes remain queued. Disabling live processing also leaves the lifecycle without remote cleanup configuration, so local maintenance continues while remote rows remain. The Modal service separately enforces absolute expiry and bounded scheduled cleanup. Physical removal may lag; neither local deletion nor backup restoration erases provider/platform retention or private backups. [Maintenance rules](../step-rules/document-maintenance.md) and the [Modal runbook](mineru-modal.md) describe the current boundaries.

## Supported host and next deployment gate

Support is one Unix host with reliable local filesystem locks, SQLite and the pinned Python runtime. Windows, shared/network filesystems and multiple application hosts are unsupported. PDF admission is bounded to 50 pages/50 MiB, with separate renderer, archive and provider limits. Current live policy uses a one-hour run deadline, 100 provider attempts across the document retry chain, and a per-document cap no greater than $30 within the authorized shared allowance.

Any public deployment other than the [Modal judge deployment](modal-deploy.md) needs its own reviewed design for TLS termination, the trusted-proxy boundary, canonical public origin and secure cookies, durable storage/locking, supervision, shutdown and retention monitoring. Changing the bind address or inserting a proxy is not enough. Repeat authentication, ownership, Host/Origin, cancellation, restart and upload-to-download acceptance on the deployed URL before calling it a hosted submission.

For the current saved demonstration, follow [preparation](../demo/preparation.md), [measured result](../demo/result.md) and [presentation/rehearsal](../demo/presentation.md). Rehearsal does not require new paid calls.

## Reading-guide configuration

The `amuseme-meta-3` configuration uses Muse Spark 1.3 at high effort with prompt version `amuseme-1`, a bounded JSON response, and a $0.50 worst-case reservation for the guide stage (it was $1.50 before the November 2 cost model below). The shared allowance follows the explicit authorization below; all prior charges remain counted. Mandatory preflight includes this reservation before extraction. Historical configurations omit both the guide model and its optional reservation and skip the guide step locally; a guide dispatch without either setting fails before a paid call. Step behavior is in the [reading-guide rules](../step-rules/reading-guide.md).

## Processing allowance

Current cumulative ceiling: **$480.564373**, budget ID unchanged, $30 per document. Each raise below was explicitly authorized by the user; all prior charges remain counted. Ceilings are worst-case reservations, not measured provider bills. Disable processing after each authorized batch; a failed run does not authorize unbounded retries or extra documents.

### November 1 reading-guide acceptance allowance

The user explicitly authorized up to $30 for one fresh six-page upload-to-download test. Immediately before that test, the preserved original budget identity contained 129 charges accounting for $70.564373 (actual cost when known, otherwise the full reservation). The new cumulative configuration ceiling is therefore $100.564373, leaving at most $30 of new accounted work. This is a reservation ceiling, not a measured provider bill or forgiveness of earlier charges. Keep the same budget ID and every ledger row; do not reset reservations. The per-document cap remains $30. Disable processing after this one acceptance run; a failed run does not authorize unbounded retries or a second paper.

### November 2 additional-papers allowance

The user explicitly authorized up to $60 more to process two additional short papers: one with data tables and one with plotted figures. The cumulative configuration ceiling is therefore $160.564373 with the same budget ID and every prior ledger row. The per-document cap remains $30. Choose papers whose mandatory reservations fit that cap. Disable processing after the two runs; a failed run does not authorize unbounded retries or a third paper.

### November 2 document-types allowance

After the two additional papers, the user explicitly authorized up to $100 more to process four short documents of other types: a biomedical article, a legal opinion, a class handout and a business or economics brief. The cumulative configuration ceiling is therefore $260.564373 with the same budget ID and every prior ledger row. The per-document cap remains $30. Disable processing after these runs; a failed run does not authorize unbounded retries or a fifth document.

### November 2 Muse review allowance

Three of the four document-type runs failed on rejected model answers before Muse review existed, consuming reservations. After Muse review steps were added, the user explicitly authorized raising the reservation ceiling by $100 to $360.564373 so the remaining documents could finish, including review rounds. Same budget ID and ledger; the per-document cap remains $30. Disable processing after these runs.

### November 2 more-examples allowance

The user explicitly authorized up to $120 more to process four new example documents of other types: a safety sheet, an instruction manual, a US patent and a code-heavy technical document. One is processed on camera for the demo video. The cumulative configuration ceiling is therefore $480.564373 with the same budget ID and every prior ledger row. The per-document cap remains $30. Disable processing after these runs; a failed run does not authorize unbounded retries or a fifth document.

The NASA and OSHA runs published figure crops that Muse's review had inflated to half the page or more. After the crop fix, the user explicitly approved re-running those two as fresh uploads, within the same $120: six runs in all. Before the re-runs, the two first runs had reserved $29.30. The six runs reserved $78.70.

### November 2 crop re-run allowance

The re-runs still published clipped or misplaced crops (NASA step drawings, OSHA pictograms), so crop review was fixed again. The user explicitly approved re-running NASA and OSHA once more on that fix, two runs, up to $35. The ledger then held $359.60 of reservations, so the server's budget is set to $394.60, below the configuration ceiling, and caps this batch at exactly $35. The per-document cap remains $30. Disable processing after these runs.

Source basis: [configuration](../../src/server/config.ts), [processing policy](../../src/processing/config.ts), [lifecycle](../../src/server/lifecycle.ts), [dispatcher](../../src/processing/dispatcher.ts), [product API](../../src/domain/api.ts) and [maintenance](../../src/server/maintenance.ts).

## Meta-only runtime transition

New normal uploads use extraction prompt version 2 with one guarded Spark request per physical page. Source-page figure regions retain explicit hashes, integer pixel bounds and a rendering recipe. Assets without provenance remain historical unspecified assets. Published old revisions stay readable; old non-Meta runs cannot dispatch or retry in this runtime. Do not relabel stored configurations or rewrite receipts to migrate them. Preserve the original ledger and policy records. A changed configured policy can intentionally make historical retries fail closed.

Before extraction, mandatory reservations for extraction, page checks, headings and the reading guide must fit the saved document cap. Figure count is unknown before extraction, so figures are not in this check.

**Cost model (November 2).** Every Meta call is preflighted with Meta's free token count. The guard rejects a call before any paid work when its worst-case charge exceeds its reservation. The worst case is the counted input plus the 65,536-token framing reserve, all at the uncached $1.25 per million input rate, plus the full 16,384-token output ceiling at $4.25 per million. The output ceiling alone costs $0.0696, and reasoning tokens count toward it. The rates are `metaRates` in the [processing policy](../../src/processing/config.ts). Because a call can no longer cost more than its reservation, reservations are set from observed usage with wide headroom, not from the 524,288-token context ceiling:

| Reservation | Before | Now | Largest admitted input | Largest observed input / output |
| --- | --- | --- | --- | --- |
| extraction (per page) | $2.50 | $0.30 | 118,758 tokens | 4,785 / 8,270 |
| page check (per page and per review round) | $1.50 | $0.30 | 118,758 tokens | 9,693 / 12,896 |
| headings | $1.50 | $0.50 | 278,758 tokens | 11,090 / 3,180 |
| guide | $1.50 | $0.50 | 278,758 tokens | 15,347 / 11,484 |
| figure description | $1.50 | $0.50 | 278,758 tokens | 6,506 / 1,647 |
| figure crop review (new `figure-crop` key) | $1.50 (figures) | $0.20 | 38,758 tokens | not yet run live; two images and a short JSON prompt, about 10,000 tokens |

The observed figures come from all 111 completed calls in the November 1–2 ledger. The most expensive call cost about $0.064 at the published rates, and the average was $0.012–$0.047 depending on stage. Headings, guide and figure descriptions read the whole document, so their reservation covers about twice the text of a 50-page upload.

Mandatory preflight is now $0.60 per page plus $1.00, so up to 48 pages fit the $30 cap. Live uploads are refused above that affordable page count, with the friendly too-long message, while PDF admission itself still stops at 50 pages. Each figure can cost up to $0.90 more: two crop-review rounds and one description. A 15-page document with 5 figures reserves at most $14.50, which leaves $15.50 for Muse review rounds of $0.20–$0.50 each. With 5 figures fully reviewed, up to 40 pages fit before review rounds.

Crop reviews and Muse reviews are admitted only when they fit beside every charge, every outstanding reservation and the remaining mandatory reservations. When the budget is short, a crop stays unreviewed with a located warning and a review falls back safely. A call whose counted input exceeds its reservation fails as `limit-exceeded` before any paid call. In a review or crop round, it falls back the same way.

Missing actual charges still retain the full reservation, so the ledger counts each new call at $0.20–$0.50 instead of $1.50–$2.50. Documents bound to the earlier policy keep it, and retries or validator repairs against that policy fail closed under the new one. Historical configurations without a guide keep their four-stage provider policy, with no guide reservation or dispatch. Per-call checks also enforce the remaining global budget, so this minimum is not a promise that a run is funded. The October 28 explicit $30 addition set the earlier allowance to $70 ($3 setup/$67 processing); the separately authorized November 1 acceptance allowance above supersedes its configuration ceiling. All prior charges remain counted. Existing documents keep their original caps and policies. The historical version-1 CLI keeps its original $37 ceiling; use the normal upload workflow for the separately authorized full-document test.
