# Dreamina CLI integration for an unchanged New API host

This integration targets official commit `9c2c370a6156b3ac41874231952a938891ac5483`. All integration files are additions under this directory. No official Go code, dependency files, database models, frontend files, or existing plugin files are modified.

## Components and installation

- `dist/dreamina-cli.js`: uploadable API v1 credit-billing plugin, key `dreamina-cli`, version `1.3.1`. Install through the official task-plugin management API or UI and select it on the bridge channel.
- `plugin.js`: shared protocol/legacy seconds implementation used by the generator. **Do not upload this source as the credit-billing release.**
- `bridge.mjs` / `server.mjs`: independent Node.js service running the Canvas CLI; A and B each use their own profile, account/team binding, database context and media directory.
- `standard-credit-pricing.json`: explicit normal-group price configuration, not host defaults. Its historical 70% benchmark is dated 2026-10-29; it is not a newly checked official price list. Kemeng pricing is outside this configuration.

The artifact is installed dynamically rather than added to the official built-in plugin catalog, whose tests enumerate a fixed set of official plugins. The host's existing loader and tests remain unchanged.

Install locked bridge dependencies with `npm ci` in this directory. Copy `config.example.json` to an operator-owned configuration and fill in the exact CLI profile, user/team, storage paths and channel label. Provide `DREAMINA_BRIDGE_CONFIG`, `DREAMINA_BRIDGE_TOKEN` and `DREAMINA_DATABASE_URL` through the service environment. `node server.mjs --check` validates configuration and the logged-in context without generating media. `node server.mjs` starts the bridge.

The example deliberately authorizes no paid generation (`unlimitedCredits: false`, model limits zero). Production account limits, concurrency, credentials and channel/pricing configuration are operator choices and are not migrated or deployed by these files.

New sample-to-full-video promotion requests are unsupported. Requests with `mode: "promote"`, `draft_task_id` or `source_job_id` are rejected before usage estimation, task creation or CLI submission with `暂不支持样片转正，请直接创建普通视频任务`. Direct bridge POST requests receive HTTP 400 and code `promotion_not_supported`. The obsolete `promotionReservationCreditsPerVideo: null` configuration remains readable, but a non-null value is rejected and cannot enable promotion. Creating draft videos with `seedance_2.5_draft` remains supported.

To rebuild a release, provide a new output filename (the generator refuses overwrites):

```sh
node build-credit-plugin.mjs reservations.example.json /tmp/dreamina-cli-reviewed.js
```

To prepare normal-group pricing, first retrieve a complete versioned `/api/option/model_pricing` snapshot for the supported models, then run:

```sh
node standard-credit-pricing.mjs /tmp/dreamina-pricing-patch.json --snapshot /path/to/snapshot.json
```

The generated patch preserves unrelated providers and uses the official optimistic version check. Existing administrator prices require an explicit replacement choice. It does not submit the patch. The existing site money convention must match the declared CNY 1:1, 500000 quota/CNY and group ratio 1 assumptions.

## Startup dispatch

Input downloads for different requests use `inputPreparationWorkers` (default 4, range 1–4). Capacity is reserved before preparation; repeated identical keys share the same preparation and conflicting bodies are rejected. Requests without references do not wait for a media preparation slot. The short admission lock still protects idempotency, capacity and canvas allocation. The existing per-request media byte limit and 30-second input timeout apply; parallel preparation increases peak memory/bandwidth compared with a single input worker. Set the value to 1 to serialize media downloads while still letting text-only requests through.

Optional fast startup confirms that the host has persisted the task instead of waiting for its first status poll. Set `gatewayChannelId` in each operator-owned bridge configuration to its exact New API channel (currently A=1, B=3 in this deployment), and supply a separate `DREAMINA_GATEWAY_DATABASE_URL` environment secret pointing to the New API primary database. Use a dedicated database account restricted to SELECT on `tasks`; do not reuse or broaden bridge writer permissions. Both settings must be present or both absent. PostgreSQL, MySQL and SQLite URLs are supported; SQLite must refer to an existing locally readable host file. No host tables, indexes or records are created or changed. `--check` additionally verifies the read connection and expected task columns when enabled.

The bridge reads only its queued task IDs in one indexed batch (up to 200) each second, matching `task_id`, `platform=dreamina-cli`, `channel_id`, `private_data.upstream_task_id` and a recognized active status. Unknown/malformed/duplicate or mismatched rows never grant startup. Database confirmations last five seconds and are rechecked during preparation; they are not restored after restart. Confirmed terminal or mismatched rows block dispatch even if an earlier status poll had granted a lease. Query failures back off to at most 30 seconds and existing authenticated host polls remain the fallback. Slow confirmation does not stop polling or downloading already accepted jobs. Once an operation has been dispatched, its existing recovery rules continue to apply; confirmation never resubmits it.

This is a read of official task persistence, not a receipt of completed billing: the unchanged host still inserts before its initial billing settlement. It reduces the orphan-submission window without providing an atomic transaction with the upstream. The reader depends on the official task schema and must be revalidated when upgrading New API. New `gatewayTaskId` and preparation/confirmation timings live only in bridge records. Legacy queued credit jobs use their existing private `billing.request_id`; older jobs without a public ID use normal polling. Plugin release and billing expressions do not change for this optimization.

## Billing and compatibility

The plugin estimates credits with the measured model/resolution/reference rules. For reference videos, the first estimate uses the model's maximum total reference duration because the standard estimate hook cannot fetch media. The adapter obtains and confirms the real quote separately from observing upstream acceptance. Ordinary quotes may exceed the estimate; normal final settlement then uses the host's existing difference-charge/refund mechanism.

Only after the original operation is terminal and delivered media is verified does the plugin report final usage. A homogeneous batch charges the accepted batch quote multiplied by delivered count / requested count. This is the customer billing allocation; it is not a claim that an upstream credit-ledger deduction was audited. Zero deliveries fail through the official refund path. Receipt identity mismatches are rejected and queried again under the host's polling policy. The official frozen submission snapshot remains an estimate after settlement; read final credit usage from the plugin's private `settledCredits` state and the settlement log, not from that estimate snapshot.

The new bridge/plugin exchange private billing receipts through response headers and persist them in plugin private state, not public task data. Completion uses the current hook's returned state, including when the first poll is terminal. Old bridges returning billing in JSON remain compatible, but their raw polling bodies do not gain the new privacy guarantee.

Legacy tasks, including previously created promotions, retain their original IDs, frozen pricing and channel ownership. Their existing bridge jobs continue processing and recovering on the original canvas; query, successful settlement, failed-task refund and artifact download remain compatible. Existing promotion records are not recreated through POST: use their original task IDs to query or download. Successful artifacts remain downloadable within the existing retention window. No migration of live task records is performed by installation.

## Limits of an unchanged host

These are not implemented by this integration:

- A host-side durable admission journal before the upstream submission, or atomic transactions spanning wallet, token, task and logs.
- Crash-safe exactly-once settlement/refund recovery across those host records, or a barrier that publishes terminal status only after the host's money adjustments finish.
- A 3-second host polling scheduler. The bridge polls upstream every 3 seconds by default; this official host schedules background task polling approximately every 15 seconds.
- Replacement of the official dashboard's precharge-based aggregates with final net-spend statistics, or a dedicated private credit-quote view in the official UI.

`UNKNOWN` is subject to the official consecutive-poll-failure and overall timeout policies; it is not an indefinite reserved-balance state. HTTP 404/410 and other host-classified errors also retain official behavior. These limitations must not be bypassed by adding hidden host hooks or changing official files.

## Verification

```sh
# Repository root: rejects official edits/deletions and out-of-scope additions
node integrations/dreamina/verify-additive.mjs

go test -count=1 ./integrations/dreamina ./plugins ./pkg/jsplugin ./relay/channel/task/jsplugin

# This directory
npm test
# Repeat storage tests against isolated supported PostgreSQL/MySQL instances:
# DREAMINA_TEST_DATABASE_URL is supplied privately in the environment.
node --test database-store.test.mjs
```

SQLite tests use Node's SQLite engine. The database suite covers repeated initialization, restart, idempotency uniqueness, context isolation, atomic legacy imports and failed sessions. Real generation and deployment are separate operations; the local HTTP fault-injection harness does not spend upstream credits.
