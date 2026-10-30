# Dreamina task latency

User approved optimizing submission, polling, downloads and gateway synchronization after examining a 1040-second task. Preserve 100-video capacity, five videos per canvas, original submit identities, pricing and profile checks.

Approach: separate durable download work from polling; increase bounded poll capacity to four and keep two downloads. Cache the public video catalogue for 60 seconds and coalesce concurrent refreshes. Coalesce simultaneous context checks only (no successful TTL cache). Dispatch every second with per-task 5-second poll spacing. Persist millisecond phase timestamps and poll counters/max gaps; all upstream completion timestamps are explicitly observations, not provider execution time.

Alternative: only increase workers cannot prevent slow downloads consuming query slots. Concurrent writes within a canvas remain unverified and are out of scope.

Gateway: use its existing channel setting to skip the one-second sleep between bridge queries (queries read local snapshots). Do not change unrelated providers or billing. Inspect the system poll schedule before adjusting any setting.

New state is backward readable; existing in-progress jobs stay pinned to their canvas and submission. Downloads resume from successful resource IDs and never resubmit generation. No paid generation is needed for rollout checks. Add regression tests and simulated backlog measurements before deployment. Back up production config and task state; drain active workers gracefully and verify health and old artifacts after rollout.
