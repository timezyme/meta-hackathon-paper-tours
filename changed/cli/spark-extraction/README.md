# Bounded Spark extraction trial

This experimental command uses a single unrotated PDF page and the normal guarded processing workflow. It fails visibly when the extraction reports figures, empty content, or incomplete page coverage. Its page-level locations and model-reported coverage do not establish source fidelity.

Use the pinned Node 24.19.0, pnpm 10.33.0, installed application dependencies, and the existing Python 3.14 / PyMuPDF 1.28.2 runtime. Run from the repository root after `pnpm check`, `pnpm test`, and `pnpm build`. Preserve the original private environment, data directory, and budget ledger. The environment must identify budget `amuseme-authorized-2026-10-27` with its original $37 processing ceiling. The command reserves at most $5.50 for extraction, page checking, and heading restoration. Normal uploads use multipage Meta extraction version 2; this command retains the historical version-1 contract.

Inspect locally without starting a server or calling a provider:

```sh
volta run --node 24.19.0 pnpm exec node --env-file=qa/implementation/live/private/server.env cli/spark-extraction/main.ts --pdf /absolute/path/one-page.pdf --owner existing-user-id --output /absolute/path/new-private-output
```

After the live trial is authorized, append `--run`. The existing server must be stopped through its ordinary shutdown before running; the process lock rejects a second writer. The command rejects queued/running or unresolved provider work and insufficient budget. It starts the existing guarded listener with HTTP uploads disabled, admits the one page through DocumentStore, waits for the normal dispatcher/Mastra workflow, writes actual published export bytes, and closes scoped resources. Use a vacant loopback port configured through `AMUSEME_PORT` and matching `AMUSEME_ORIGIN` if necessary. Do not replace the original data directory to avoid a lock conflict.

The output directory must not already exist. It receives trial identity, the published manifest, `normalized.txt`, and the normal JSON exports. Raw envelopes and source images stay in the original private artifact store. Failures retain the trial identity and saved response; they publish no partial revision and never trigger an automatic paid retry. The command does not reset run states, duplicate the database, deploy, or alter the budget.

Do not put source answer keys or evaluation ground truth into the extractor input. Compare the source page and exported content separately after generation.
