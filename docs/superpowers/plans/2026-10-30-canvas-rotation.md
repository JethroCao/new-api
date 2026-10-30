# Canvas Rotation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans; implement inline with focused tests and one fresh final review.

**Goal:** 每张新画布最多 5 次请求，按北京时间日期命名并保持旧任务可访问。
**Architecture:** 桥接层持久化画布分配台账，准入锁内保留名额；执行时幂等创建画布，按任务 projectId 路由。
**Tech Stack:** Node.js ESM, node:test, official dreamina-canvas CLI.
**Spec:** docs/superpowers/specs/2026-10-30-canvas-rotation-design.md

## Global Constraints
- `Nexora-YYYYMMDD-NNN`, Asia/Shanghai, 5 requests per new canvas.
- Preserve legacy projectId and job context hash, charging policy and task protocol.
- Promotion remains on source canvas and consumes capacity, rejecting before charging when full.
- No paid generation tests or unrelated dirty files.

## Review Focus
- Parallel submissions and duplicate keys across restarts.
- Allocation/create persistence failures and stable UUID retries.
- Midnight, existing full legacy canvas and promotion.
- Upload/status/download isolation after default canvas changes.
- Corrupt/missing registry must not silently route bound jobs elsewhere.

## Tasks
- [x] Add canvas-pool.mjs and canvas-pool.test.mjs: reserve(key,digest,preferredProjectId), ensureCreated(projectId,create), persistent reload. RED then GREEN: 11 requests -> [5,5,1], duplicates, failed persistence, day rollover, rename tolerance, source-full rejection.
- [x] Add bridge rotation tests before implementation; integrate pool open, reservation and per-job routing. Verify legacy polling/download, references, batch count, promotion and failure retries; clients cannot choose projectId.
- [x] Update README/config example; run node --test integrations/dreamina/*.test.mjs (separate existing expensive stress cases when needed), diff check, fresh review.
- [x] Deploy versioned bridge release and config canvasTaskLimit=5. Validate official idempotent empty-canvas creation, service health, stored bindings and unchanged queue/credit settings. Keep rollback artifacts; don't roll back to a binary that ignores bound projectId after new tasks exist.

## Execution record
- Design and 5-task limit approved in conversation; user explicitly chose strict promotion capacity.
- Existing feature branch retained, pre-change files saved under outputs/dreamina-canvas-rotation to isolate this work from earlier uncommitted changes.

- Final review: one P2 found (pending reservation ignored after disabling rotation). Added reproducer, saw RED, then fixed lookup-before-policy; 61 focused regression tests GREEN.
- Existing HTTP 200 stress test timed out on this machine and was stopped; a separate bounded raw HTTP diagnostic admitted all 200 requests. The expensive 200-slot scheduler test was not rerun. No claim that the full stress suite passed.
- Server Node 24.22.1: 23 rotation/plugin tests passed. Official CLI create called twice with the same UUID returned one canvas; no generation or credits used.
- Deployment first bootstrap failed reading a root-owned prepared record, restored previous release automatically. Corrected ownership to the existing service user and retried successfully.
- Active release: /data/dreamina/releases/fd6c22633-canvas5-20261030. canvasTaskLimit=5, previous 200/200/200 concurrency and 1800s queue settings preserved. 223 historical jobs registered without moving.
- First empty canvas: Nexora-20261030-001 / 076e54d6-35c7-43fd-85c0-c028ed995c86.

## Git integration follow-up
- Before pushing, diagnosed the existing HTTP 200-case hang: a burst of TCP connects can reset at the OS accept backlog and leave held requests pending during cleanup. Test now establishes connections progressively while holding all 200 in flight, verifies health remains available, request 201 returns 429, and every admitted request returns 202 after release. Both 2 and 200 cases pass.
- Frontend full suite: 201 files / 2440 tests pass. Production build, type check using installed tsgo (the available Bun has no built-in check command), changed-file lint and formatting pass. Whole-tree formatter reports 21 pre-existing unrelated files, none changed here.
- Go plugin and JavaScript-host suites pass.
- Full bridge suite now passes: 63 tests, zero failures or skips, including HTTP admission at 200 and the 200-slot scheduler; duration 220 seconds.
