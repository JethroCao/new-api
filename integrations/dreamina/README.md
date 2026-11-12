# Dreamina CLI integration for an unchanged New API host

This integration targets official commit `9c2c370a6156b3ac41874231952a938891ac5483`. All integration files are additions under this directory. No official Go code, dependency files, database models, frontend files, or existing plugin files are modified.

## Components and installation

- `dist/dreamina-cli.js`: uploadable API v1 credit-billing plugin, key `dreamina-cli`, version `1.4.0`. Install through the official task-plugin management API or UI and select it on the bridge channel.
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

Input preparation for different requests uses `inputPreparationWorkers` (default 4, range 1–4). Each request downloads up to three references at a time while preserving their order. Downloads share the request's media byte limit and a 60-second deadline that starts when preparation begins. A failure cancels the other downloads in the request. Capacity is reserved before preparation, repeated identical keys share the same preparation, and conflicting bodies are rejected. Requests without references do not wait for a preparation slot. The short admission lock protects idempotency, capacity and canvas allocation.

Optional fast startup confirms that the host has persisted the task instead of waiting for its first status poll. Set `gatewayChannelId` in each operator-owned bridge configuration to its exact New API channel (currently A=1, B=3 in this deployment), and supply a separate `DREAMINA_GATEWAY_DATABASE_URL` environment secret pointing to the New API primary database. Use a dedicated database account restricted to SELECT on `tasks`; do not reuse or broaden bridge writer permissions. Both settings must be present or both absent. PostgreSQL, MySQL and SQLite URLs are supported; SQLite must refer to an existing locally readable host file. No host tables, indexes or records are created or changed. `--check` additionally verifies the read connection and expected task columns when enabled.

The bridge reads only its queued task IDs in one indexed batch (up to 200) each second, matching `task_id`, `platform=dreamina-cli`, `channel_id`, `private_data.upstream_task_id` and a recognized active status. Unknown/malformed/duplicate or mismatched rows never grant startup. Database confirmations last five seconds and are rechecked during preparation; they are not restored after restart. Confirmed terminal or mismatched rows block dispatch even if an earlier status poll had granted a lease. Query failures back off to at most 30 seconds and existing authenticated host polls remain the fallback. Slow confirmation does not stop polling or downloading already accepted jobs. Once an operation has been dispatched, its existing recovery rules continue to apply; confirmation never resubmits it.

This is a read of official task persistence, not a receipt of completed billing: the unchanged host still inserts before its initial billing settlement. It reduces the orphan-submission window without providing an atomic transaction with the upstream. The reader depends on the official task schema and must be revalidated when upgrading New API. New `gatewayTaskId` and preparation/confirmation timings live only in bridge records. Legacy queued credit jobs use their existing private `billing.request_id`; older jobs without a public ID use normal polling. Plugin release and billing expressions do not change for this optimization.

## Optional private OSS video delivery

OSS is opt-in and affects only new video admissions. Existing jobs keep their original local delivery and retention; no backfill or official schema changes are performed. Add this configuration to the bridge operator's JSON on each CLI machine:

```json
{
  "ossWorkers": 2,
  "oss": {
    "bucket": "nexora-media-prod",
    "region": "oss-cn-hangzhou",
    "prefix": "prod/videos",
    "internal": true,
    "signedUrlSeconds": 86400
  }
}
```

Provide `DREAMINA_OSS_ACCESS_KEY_ID` and `DREAMINA_OSS_ACCESS_KEY_SECRET` through the protected service environment, never the JSON config, plugin source or request body. Use a private Standard-storage bucket. The uploader uses OSS V4 signatures and a private object ACL; the existing RAM object permissions (`oss:PutObject`, `oss:GetObject`, `oss:DeleteObject` on this bucket only) suffice for the upload/read operations. No object listing or bucket management operation is performed. This integration never deletes OSS objects; the DeleteObject grant is not exercised. Ensure no existing bucket lifecycle rule expires this prefix if long-term retention is required. `internal: true` uses the Hangzhou internal endpoint for upload/verification; signed client URLs always use the public HTTPS endpoint. A laptop outside that VPC needs `internal: false` for a separately authorized live upload test. `--check` validates configuration/credentials locally, but does not upload an OSS test object or prove RAM permissions.

Each job freezes its destination at admission. The existing adapter job JSON stores the output index and `files[].oss` (`bucket`, `region`, `key`, byte length, SHA-256 and upload time). Object keys are `prod/videos/YYYY/MM/DD/<public-task-id>/outputs/001.mp4` (UTC date; adapter job UUID is used when no public task ID exists). The adapter uploads only verified successful outputs, persists each upload checkpoint, then signs all URLs before reporting completion. SHA-256 metadata and length are checked with HEAD; Content-MD5 validates the PUT payload. A lost upload response is recovered with HEAD instead of uploading again. Upload failures remain in progress with `retry_upload`, use a separate bounded worker lane (default 2, allowed 1–4), and back off to 60 seconds without regenerating. The unchanged host's overall task timeout still applies; prolonged OSS outages must be handled operationally before that deadline.

`GET /v1/videos/{task_id}` adds these fields for successful OSS jobs:

```json
{
  "storage": "oss",
  "video_url": "https://<bucket>.oss-cn-hangzhou.aliyuncs.com/<object>?<signature>",
  "video_urls": ["https://<bucket>.oss-cn-hangzhou.aliyuncs.com/<object>?<signature>"],
  "download_url_expires_at": 1794460800
}
```

`video_url` is the first delivered output; `video_urls` contains all delivered outputs in the same order as artifact keys (`video`, `video-2`, ...). The timestamp is Unix seconds. **These are fixed signed snapshots persisted in the task result, valid for 24 hours by default from signing, not from each query.** The official renderer does not perform network I/O or refresh terminal tasks. Repeated queries return the same links, including after expiry. Download and retain a copy within that window; after expiry, the original authenticated `/content`/artifact download endpoints still work by obtaining a fresh server-side OSS signature. No new public route or host renderer is introduced. A URL is a bearer credential for its validity window: do not publish task responses or access-log query strings. The durable object identity is the bucket/key, not the signature snapshot.

References stay local. Local successful outputs retain their existing fixed eight-hour deadline measured from original download completion, but cleanup only removes them after OSS is ready; pending uploads remain protected. Inputs retain the existing eight-hour terminal-task cleanup. OSS objects and task associations remain after local cleanup. There is no eight-hour `content_expires_at` on OSS results. The old proxy download supports GET, HEAD and Range after local cleanup, forwarding no bridge credentials to OSS. Keep the configured bucket and region available for historical downloads; changing destination does not migrate old objects. A signed snapshot that expires before a severely delayed host terminal poll cannot be refreshed by repeated task queries: use `/content` instead.

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
