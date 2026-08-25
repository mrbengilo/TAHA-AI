# TAHA-AI Codex Operating Rules

## Goal
Build TAHA-AI quickly and safely while minimizing unnecessary model cost. The primary Codex thread is a cheap router/coordinator. It must classify each task before implementation and use the lowest model tier that can complete the task reliably.

## Automatic task routing
Classify by actual engineering risk and changed surfaces, not by how long the user prompt is.

### T0 — FAST
Use the primary thread directly, or the `fast` agent for a parallel low-risk subtask.
Typical work:
- copy/text/icon changes
- CSS, spacing, simple responsive fixes
- tiny isolated component changes
- simple validation
- small tests or docs
- mechanical rename with no behavior change

Model target: GPT-5.6 Luna, low reasoning.

### T1 — STANDARD (default)
Spawn `standard` for normal implementation.
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
Spawn `deep` when the core task includes one or more of:
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
Spawn `critical` only for:
- security/auth boundary changes
- possible data corruption
- irreversible/dangerous migrations
- production incidents with significant impact
- architecture-wide refactors
- cross-channel correctness failures that can publish wrong product/media/content
- a difficult issue that remains unresolved after a proper `deep` attempt

Model target: GPT-5.6 Sol, xhigh reasoning.

## Routing rules
1. Default to T1 when uncertain between T0 and T1.
2. Use T2/T3 only when the task actually contains the listed risk; do not escalate because the prompt is long.
3. If an agent returns `ESCALATION_REQUIRED`, escalate exactly one tier and pass forward its findings. Do not restart investigation from zero.
4. Do not make more than two materially identical failed attempts at the same tier.
5. Never use a stronger model merely to rewrite, reformat, rename, or perform a mechanical edit.
6. Use at most two subagents concurrently, and only for independent workstreams that will not edit the same files.
7. Prefer one capable agent over many agents when the work is tightly coupled; parallelism is for wall-clock savings, not brainstorming.
8. Stop when acceptance criteria and validation pass. Do not continue opportunistic refactoring.

## TAHA-AI invariants
Preserve these unless an explicit product requirement changes them:
- Google Sheet product SKU is the canonical product key.
- The corresponding Google Drive product folder is `SKU <SKU>`, e.g. SKU `PH0006` maps to folder `SKU PH0006`.
- Generated media for a product must remain associated with that same SKU/product and should be saved back to the correct SKU media location when that workflow requires it.
- One-click multi-channel publishing must be idempotent: retries must not silently create duplicate listings/posts.
- A failure on one channel must not falsely mark other channels as successful or destroy their successful state.
- Store credentials, OAuth refresh tokens, and secrets server-side only; never expose or log them in client code.
- External channel behavior must come from existing repository contracts or current official API documentation; never invent API fields/endpoints.

## Implementation workflow
1. Read the task and inspect only the repository areas needed to classify it.
2. State the internal tier decision briefly, then execute without asking for confirmation unless a genuinely missing requirement blocks correctness.
3. Reuse existing architecture and utilities before adding abstractions.
4. Keep diffs focused and backward-compatible where practical.
5. Add/update regression coverage for behavior changes when practical.
6. Validate with the cheapest meaningful checks first.
7. For substantial T1/T2/T3 code changes, run `pnpm lint` and `pnpm test` unless the environment prevents it. Note that `pnpm test` already runs the project build before Node tests.
8. Report changed behavior, validation performed, and any remaining risk. Do not dump long reasoning.

## Cost and speed policy
- Luna: routing and low-risk mechanical work.
- Terra: default implementation tier.
- Sol High: difficult integration/engineering work.
- Sol XHigh: rare critical work only.
- Keep output concise; spend tokens on inspection, implementation, and validation rather than narration.
- Reuse findings and context when escalating instead of re-reading the whole repository.

## Scope discipline
Do not change unrelated business rules, UI, database schema, APIs, deployment configuration, or dependencies unless necessary for the requested task. If an unrelated defect is discovered, record it separately instead of expanding the current task.
