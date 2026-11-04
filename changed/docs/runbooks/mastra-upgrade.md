# Upgrade Mastra and bundled Studio together

Treat the framework, storage/observability adapters, CLI and generated Studio assets as one reviewed change. This procedure does not select new versions or authorize inference/deployment. Follow [application operations](application-operations.md) for the private data directory, process lock and shutdown.

## Establish the candidate

Record the working source revision/file hashes, package/lockfile, runtime versions, configuration and generated artifact hashes. Current direct pins are `@mastra/core` 1.79.0, `@mastra/deployer` 1.79.0, `@mastra/libsql` 1.27.0, `@mastra/observability` 1.21.0 and CLI `mastra` 1.35.0. Their release numbers need not match. Review a compatible set together; do not independently replace Studio assets or float transitive dependencies.

Read candidate packages' embedded `dist/docs/`, public export maps, types and installed source. Check the server factory, agent model adapter, workflow restart/snapshot semantics, LibSQL schema/migrations, observability and shutdown APIs. Installed source outranks remembered APIs. Keep Effect/AI SDK compatibility explicit. Do not patch `node_modules`, import private framework modules or weaken guards to accommodate a changed API.

Use a separate candidate checkout with disposable fixture storage and live processing disabled. Set these variables to the reviewed exact versions, then run:

```sh
pnpm add --save-exact \
  "@mastra/core@${AMUSEME_NEXT_CORE:?Set reviewed exact version}" \
  "@mastra/deployer@${AMUSEME_NEXT_DEPLOYER:?Set reviewed exact version}" \
  "@mastra/libsql@${AMUSEME_NEXT_LIBSQL:?Set reviewed exact version}" \
  "@mastra/observability@${AMUSEME_NEXT_OBSERVABILITY:?Set reviewed exact version}"
pnpm add --save-dev --save-exact "mastra@${AMUSEME_NEXT_CLI:?Set reviewed exact version}"
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm list --depth 0
```

Review both `package.json` and the complete `pnpm-lock.yaml` diff, including new packages, native requirements, notices and migrations. Keep the pinned Node/pnpm unless a separate reviewed change requires otherwise. Installation must retain the Effect checker and repository hooks.

## Recheck access and durability

Inventory the candidate server factory's actual routes against [the access gate](../../src/server/access.ts), [Studio allowlist](../../src/server/studio-access.ts), [composition](../../src/mastra/amuseme.ts) and [Studio rules](../step-rules/studio-inspection.md). New routes remain denied until individually reviewed. Do not permit every `/admin/api` route to fix a Studio compatibility error. Recheck anonymous/user/admin denial, encoded aliases, Host/Origin, assets, direct APIs, generic agent/tool execution and workflow mutation. Admin status still grants no document claim or paid-call permission.

Run the focused suite before full acceptance:

```sh
pnpm exec vitest run \
  tests/auth/auth.test.ts tests/server/access.test.ts \
  tests/server/lifecycle.test.ts tests/server/lifecycle-cancellation.test.ts \
  tests/server/observability.test.ts tests/server/retention.test.ts \
  tests/server/maintenance.test.ts tests/server/process-lock.test.ts \
  tests/server/document-retry.test.ts tests/server/outputs.test.ts \
  tests/processing tests/paper/meta tests/storage
pnpm check
pnpm test
pnpm build
```

Use a private disposable copy of the complete stopped-process data snapshot to test migrations and existing workflow readability with providers disabled or fixture-controlled. A real saved active LibSQL snapshot must resume without repeating completed extraction. An initial pending snapshot may start only under the strict never-started contract; an executed pending snapshot must not reset. Verify callback drain before store closure, saved-response reuse without dispatch, retry idempotency, source/output bytes, atomic publication and unchanged spending records. Fixture tests do not establish the safety of an untested live migration.

`pnpm build` regenerates React output, `.mastra/output/app`, bundled `.mastra/output/studio` and `dist/server.mjs`. Inspect actual output and package identities; do not retain an old Studio bundle or edit generated HTML/CSS to hide incompatible controls. Serve with `pnpm start` using a separate absolute data directory and port. Confirm readiness, auth, product deep links, artifact routes and the admin entry use that build.

Complete direct Chrome verification on the frozen candidate using the [development harness](development-harness.md#verify-in-a-browser). Inspect registered agents, workflow graph/run details and traces in stock Studio, plus ordinary-user/anonymous denial and direct API restrictions. Exercise reader, downloads/copy, ratings, retries, deletion and reconnect. Record errors, versions, command results, artifact hashes and serving URL. Any live-provider check retains its separate authorization.

## Cutover and rollback

Before cutover, stop the live application and auxiliary writers, confirm exit, and snapshot the entire private data directory with SQLite sidecars, sources/artifacts, auth, workflow/trace storage, policies, attempts, cleanup records and budget ledger. Preserve matching configuration/secrets and full package/lockfile/source/build identity. Do not copy unrelated individual databases or discard the lock file.

A package downgrade is not a database rollback. On failure, keep live dispatch stopped. Restore the previous complete source/package/lockfile set, reinstall with `pnpm install --frozen-lockfile --strict-peer-dependencies`, and regenerate artifacts with `pnpm build`. Restore the matching complete data snapshot only when no later accepted work, provider activity or charge would be lost. Never run older packages blindly against a newer database, mix snapshots, reset the ledger, change the budget ID or retry unknown calls. If post-snapshot activity exists, preserve it and use a reviewed forward repair rather than silently rolling it back.

After cutover or an approved restore, use the guarded entry point and repeat readiness, ownership, saved-run and artifact checks. Retain the prior package/build and protected backup until acceptance. Commands and paths were checked against the October 27, 2026 checkout; writing this guide performed no update, migration, rollback, provider call or production restart.
