# TAHA-AI Codex Operating Rules

## Goal
Build TAHA-AI quickly and safely with completion speed and correctness as the primary priorities. Control cost, but never use a model or reasoning tier below GPT-5.6 Terra with medium reasoning for user-requested implementation work.

## Minimum execution floor
- Every user task starts at **GPT-5.6 Terra / medium reasoning** or stronger.
- Do not route user work to Luna or low reasoning.
- Small tasks may be handled directly by the primary Terra Medium thread to avoid delegation overhead.
- Escalate proactively when task characteristics already justify Sol; do not deliberately try a weaker tier first just to save tokens.

## Automatic task routing
Classify by actual engineering risk and changed surfaces, not by prompt length.

### T0 — QUICK
Use the primary thread directly, or the `fast` agent for an independent quick subtask.
Typical work:
- copy/text/icon changes
- CSS, spacing, responsive fixes
- isolated component changes
- simple validation
- small tests/docs
- mechanical rename with no behavior change

Model target: GPT-5.6 Terra, medium reasoning.

### T1 — STANDARD (default)
Use `standard` for normal implementation.
Typical work:
- React/TypeScript screens and components
- CRUD
- ordinary API endpoints
- product and media flows
- contained Google Drive / Google Sheets work
- scheduler features
- bounded refactors
- normal bug fixes

Model target: GPT-5.6 Terra, medium reasoning.

### T2 — DEEP
Use `deep` immediately when the core task includes one or more of:
- OAuth or token refresh
- webhook verification/processing
- queue, worker, retry, backoff, rate limiting
- idempotency or duplicate-publish prevention
- database migration or transaction logic
- concurrency/race conditions
- complex Facebook/Zalo/TikTok/Shopee/website channel adapters
- cross-channel publishing or partial-failure recovery
- difficult bugs spanning multiple subsystems
- production-sensitive integration behavior

Model target: GPT-5.6 Sol, high reasoning.

### T3 — CRITICAL
Use `critical` for:
- security/auth boundary changes
- possible data corruption
- irreversible/dangerous migrations
- production incidents with significant impact
- architecture-wide refactors
- cross-channel correctness failures that can publish wrong product/media/content
- a difficult issue that remains unresolved after a proper `deep` attempt

Model target: GPT-5.6 Sol, xhigh reasoning.

## Routing rules
1. Terra Medium is the hard minimum for all user-requested work.
2. Default to T1 for ordinary implementation; T0 is only a low-overhead path using the same Terra Medium capability.
3. If T2/T3 criteria are visible from the task or inspected code, route there before implementation instead of waiting for a lower tier to fail.
4. If an agent returns `ESCALATION_REQUIRED`, escalate exactly one tier and pass forward its findings. Do not restart investigation from zero.
5. Do not make more than two materially identical failed attempts at the same tier.
6. Use up to three subagents concurrently only for genuinely independent workstreams that will not edit the same files or depend on each other's unfinished changes.
7. For tightly coupled work, prefer one stronger agent over multiple agents; avoid coordination overhead.
8. Parallelize repository inspection, independent channel adapters, independent tests, or independent UI surfaces when doing so reduces wall-clock time.
9. Stop as soon as acceptance criteria and validation pass. Do not continue opportunistic refactoring.

## TAHA-AI invariants
Preserve these unless an explicit product requirement changes them:
- Google Sheet product SKU is the canonical product key.
- The corresponding Google Drive product folder is `SKU <SKU>`, e.g. SKU `PH0006` maps to folder `SKU PH0006`.
- Generated media for a product must remain associated with that same SKU/product and should be saved back to the correct SKU media location when that workflow requires it.
- One-click multi-channel publishing must be idempotent: retries must not silently create duplicate listings/posts.
- A failure on one channel must not falsely mark other channels as successful or destroy their successful state.
- Store credentials, OAuth refresh tokens, and secrets server-side only; never expose or log them in client code.
- External channel behavior must come from existing repository contracts or current official API documentation; never invent API fields/endpoints.

## Fast implementation workflow
1. Read the task and inspect only repository areas needed to classify and implement it.
2. Choose T0/T1/T2/T3 immediately; do not spend a separate long planning pass when the scope is clear.
3. Execute without asking for confirmation unless a genuinely missing requirement blocks correctness.
4. Reuse existing architecture, utilities, types, adapters, and tests before creating new abstractions.
5. Keep diffs focused and backward-compatible where practical.
6. For independent subproblems, run up to three agents in parallel. For coupled changes, keep one owner agent.
7. Add/update regression coverage for behavior changes when practical.
8. Run the cheapest meaningful checks first. For substantial T1/T2/T3 code changes, run `pnpm lint` and `pnpm test` unless the environment prevents it. `pnpm test` already runs the build before Node tests.
9. If validation fails, use the failure output directly; do not repeat repository discovery unnecessarily.
10. Report changed behavior, validation performed, and remaining risk concisely. Do not dump long reasoning.

## Speed and cost policy
- Minimum floor: Terra Medium.
- Default: Terra Medium.
- Sol High: use proactively for difficult integration/engineering work.
- Sol XHigh: use for critical-risk work.
- Never use Luna/Low for user-requested tasks in this repository.
- Keep output concise and spend tokens on inspection, implementation, and validation rather than narration.
- Reuse findings and context when escalating instead of re-reading the whole repository.
- Avoid unnecessary agent delegation for tiny tasks because delegation itself adds latency.

## Scope discipline
Do not change unrelated business rules, UI, database schema, APIs, deployment configuration, or dependencies unless necessary for the requested task. If an unrelated defect is discovered, record it separately instead of expanding the current task.
