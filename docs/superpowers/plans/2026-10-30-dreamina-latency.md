# Dreamina Latency Implementation Plan

> Execute inline with superpowers:executing-plans and test-driven-development.

**Goal:** Reduce avoidable queue and synchronization delay and expose diagnostic timings.
**Architecture:** Bounded submit/poll/download lanes in the existing Node bridge; existing gateway channel setting for fast local queries.
**Tech Stack:** Node.js, node:test, existing New API settings.
**Spec:** ../specs/2026-10-30-dreamina-latency-design.md

## Constraints and review focus
Preserve idempotency, per-canvas five-video cap and uncertain-submit recovery. No auth TTL caching. No provider-time claims. Verify restart during download, partial success, download failure, context drift and stale catalogue refresh failure.

## Tasks
- [x] Add failing tests for download isolation/restart, cache expiry/coalescing, and timing persistence.
- [x] Implement independent download lane, fair paced polling, phase timestamps and bounded public diagnostics. Update existing lifecycle tests for separate download dispatch.
- [x] Implement coalesced context checks and 60-second catalogue cache with fail-closed expiry. Run full bridge suite and deterministic backlog benchmark.
- [x] Document settings and diagnostic meanings. Review complete diff and fix important findings with regression tests.
- [ ] Stage release; run server tests and read-only preflight; back up/drain/switch; configure only Dreamina gateway polling; verify historical task continuity and artifact access without paid generation.

## Execution record
Baseline test first attempt hit sandbox EPERM on loopback listen; rerunning with network permission. Working in clean checkout on isolated branch perf/dreamina-task-latency, preserving the existing workspace layout.

Baseline 69/69 passed. New feature tests failed against old implementation, then passed. Final 76/76 passed, including HTTP auth/ranges, partial completion, timeout recovery, 100-task scheduling, cache expiry, context drift, and partial-download restart. git diff --check clean.
Independent reviewer found no critical/important issue; fixed the stale failed-poll finish timestamp with a RED→GREEN assertion and added interrupted second-download recovery coverage. Deterministic immediate-response simulation: first visit to all 100 tasks takes 245s at 2 workers/5s dispatch versus 24s at 4 workers/1s dispatch; this is a scheduler simulation, not a real generation latency claim.
Ruling: use existing channel setting rather than changing Go polling/global 15s scheduling; only the local bridge channel gets skip-sleep. This avoids changing external providers and leaves up to one gateway scheduling cycle of synchronization delay.
