---
name: kotlin-coroutines
description: Coroutine usage guardrails for Kotlin backend reviewers
license: MIT
---

## Mission
- Preserve non-blocking performance characteristics by enforcing clear coroutine boundaries.
- Prevent thread pool exhaustion, deadlocks, and latency spikes caused by mixing blocking and suspend flows.

## Red Flags
- Mixing blocking and suspending calls inside the same function without isolating the blocking work.
- Calling `runBlocking` anywhere other than top-level entrypoints (resources, `main`) or when explicitly bridging to blocking code with the correct dispatcher.
- Using `async { ... }.await()` immediately, or using `async` just to change dispatchers.
- Wiring `AsyncResponse` (Dropwizard) to wrap blocking DAO calls instead of true suspend flows.

## Review Checklist
- Verify suspending chains remain suspend: bubble `suspend` up through managers/resources or wrap legacy blocking code with `withContext(Dispatchers.IO)`.
- Ensure blocking functions stay blocking all the way up the call stack; prefer dedicated blocking helpers (e.g., `getUserBlocking`) rather than ad-hoc `runBlocking`.
- When bridging to suspend from non-suspend contexts, check the dispatcher passed to `runBlocking` matches the underlying workload (usually `Dispatchers.IO`).
- Confirm `AsyncResponse` is only applied to non-blocking suspend flows (Cosmos, service clients with `await`/`executeAwait`). Flag usages that simply wrap JDBI or other blocking calls.
- Look for nested coroutine builders. Replace `async/await` pairs used sequentially with direct calls; use concurrent `async` only when awaiting later.
- Ensure dispatcher changes use `withContext`, not `async`, and that blocking calls inside suspend functions are guarded with the appropriate context.

## Tooling Tips
- `Grep` for `runBlocking`, `.await()`, `executeSync`, or `AsyncResponse` to inspect how coroutines and blocking APIs mix.
- `Read` affected managers/resources to trace whether suspend functions bubble correctly.
- `Glob` modules like `*Manager.kt`, `*Resource.kt`, and `*Dao.kt` when you need broader context about call chains.
