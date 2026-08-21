---
title: Add soft and hard review finalization
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-20
updated: 2026-08-21
---

# Add soft and hard review finalization

## Goal

pi-reviewer must give the review model a normal chance to finish before it forces a structured
submission. The review will use three phases:

1. Ten minutes of normal exploration.
2. Up to two minutes of normal soft finalization.
3. If soft finalization does not submit a review, up to two minutes for one provider-level forced
   `submit_review` request.

Each phase starts only after the prior phase has stopped and Pi has confirmed that the session is
idle. The soft and hard finalization phases each receive their own full two-minute budget. Queue
cleanup and cancellation use separate bounded allowances and do not consume either finalization
budget.

This plan replaces the finalization design in
[the cooperative deadline plan](2026-08-10-pi-reviewer-deadlines-plan.md). The warning and
exploration-budget parts of that plan remain valid.

## Decision

Use the normal Pi `AgentSession` for exploration and soft finalization. Use a direct public
Pi AI request only for hard finalization.

Soft finalization keeps the selected thinking level, system prompt, session context, model, and full
ordered tool definitions. Pi adds one finalization user message. The extension blocks the execution
of every tool except `submit_review`, but the request still contains the full tool list. This phase
lets the model think and submit through the normal Pi loop.

If soft finalization ends or times out without a valid submission, pi-reviewer stops it and confirms
that it is idle. pi-reviewer then moves the native session leaf back to the entry saved immediately
before soft finalization. The failed soft branch stays in the append-only session as evidence. Hard
finalization builds its context from that pre-soft branch and adds the same finalization user message.
It sends exactly one request through the public `ModelRuntime` and Pi AI interfaces with:

- Reasoning disabled.
- Named tool choice forced to `submit_review`.
- The full ordered tool definitions unchanged.
- No automatic retry.
- A separate two-minute request deadline.

The hard response is valid only when it contains exactly one schema-valid `submit_review` call and
no other tool call. Prompt wording and execution-time blocking are not hard-enforcement mechanisms.

## Evidence that changed the design

A bounded DeepSeek canary for `vllm-project-vllm-pr-15998-a800045d0e24` failed under the current
design.

The session showed these facts:

- Exploration produced 282,800 characters of partial thinking before cancellation.
- Pi recorded a thinking-level change from `high` to `off`.
- Pi recorded the finalization user message.
- No session entry followed that message.
- No `submit_review` call occurred.
- The worker did not exit during the finalization grace period or the cleanup allowance.
- The parent watchdog killed the worker.

The current controller queues `session.steer(finalizationPrompt)` before it calls `session.abort()`.
Real `AgentSession.abort()` waits for the session to become idle. `AgentSession` can continue a queued
steering message after it aborts the active turn. The abort call can therefore wait through the
finalization continuation that the controller meant to start later. The unit-test fake returned from
`abort()` immediately and did not model this queue and idle behavior.

The extension guard can block a tool after the model requests it. It cannot require the provider to
return a tool call. Hard finalization therefore needs request-level named tool choice.

## Timing contract

The default timeline is:

| Stage                             | Default limit | Starts when                                                                  |
| --------------------------------- | ------------: | ---------------------------------------------------------------------------- |
| Exploration                       |    10 minutes | The initial review prompt starts                                             |
| Quiesce before soft finalization  |    30 seconds | Exploration reaches its limit or another finalization trigger fires          |
| Soft finalization                 |     2 minutes | Exploration abort settles and the session is idle                            |
| Quiesce before hard finalization  |    30 seconds | Soft finalization ends or reaches its limit without a submission             |
| Hard finalization                 |     2 minutes | Soft abort settles, the session is idle, and the pre-soft branch is restored |
| Hard-request cancellation cleanup |    30 seconds | The hard request reaches its limit                                           |

A normal run can therefore use up to 15 minutes and 30 seconds before parent termination handling.
An early valid submission ends the run immediately. A soft response that finishes without a valid
submission also moves to hard finalization immediately after quiescence; pi-reviewer does not wait
out an idle timer.

`--time-budget` continues to set the exploration duration. `--finalization-grace` sets the soft
finalization duration. Add `--hard-finalization-grace` for the hard request, with the same two-minute
default. Keep the quiescence and cancellation allowances as reviewed worker constants unless later
evidence shows that they need user configuration.

A model-request limit triggers the same soft-then-hard sequence. The exploration request limit does
not prevent either finalization phase from making the requests needed by this contract.

## Lifecycle states

Add one explicit state machine with these states:

```text
exploring
quiescing_before_soft
soft_finalizing
quiescing_before_hard
hard_finalizing
accepted
failed
shutdown_ready
```

Only these transitions are valid:

```text
exploring -> accepted
exploring -> quiescing_before_soft
quiescing_before_soft -> soft_finalizing
quiescing_before_soft -> failed
soft_finalizing -> accepted
soft_finalizing -> quiescing_before_hard
quiescing_before_hard -> hard_finalizing
quiescing_before_hard -> failed
hard_finalizing -> accepted
hard_finalizing -> failed
accepted -> shutdown_ready
failed -> shutdown_ready
```

Every transition records a reason and a timestamp. Only one terminal transition can win. Time,
request-count, model-error, and missing-submission triggers use this state machine and cannot start
competing finalization turns.

## Phase behavior

### Exploration

Exploration keeps the current behavior for prompts, thinking, warnings, tools, compaction, and early
submission. `submit_review` can end the review at any time.

At an exploration finalization trigger, the controller:

1. Stops warning delivery.
2. Clears all pending steering and follow-up messages.
3. Saves the trigger reason.
4. Calls `session.abort()` without first queuing a finalization message.
5. Waits for the real session to report idle.
6. Fails if quiescence does not finish within its 60-second allowance.

The 60-second allowance leaves margin beyond the 30-second provider abort boundary observed in the
Immich Qwen canary. If the allowance expires, later abort or idle settlement does not append
lifecycle events after the terminal transition.

### Soft finalization

After exploration is idle, the controller saves the current native session leaf ID as
`preSoftLeafId`. It changes the review guard to the `soft_finalizing` phase through the shared public
Pi event bus. The guard blocks all tool execution except `submit_review` without changing the active
tool definitions.

The controller then calls `session.prompt(finalizationPrompt)`. It does not use `steer` or
`followUp`. The normal `AgentSession` owns the turn, stream, native message appends, tool loop, and
compaction behavior. The model keeps the thinking level selected for exploration.

Soft finalization has up to a full two minutes. It ends when:

- `submit_review` is accepted.
- The normal turn settles without a submission.
- The soft deadline expires.
- The model or session fails.

A missing submission, model failure, or timeout moves to quiescence before hard finalization. The
controller clears queues, calls `abort()` without steering, and waits for idle. The failed soft
assistant messages and tool results stay in the native session tree.

### Hard finalization

After soft finalization is idle, the controller records the soft branch leaf and calls
`SessionManager.branch(preSoftLeafId)`. The next append starts a new branch. This keeps the failed
soft branch in the same native JSONL file but excludes it from hard-finalization context.

The controller uses public Pi APIs to build the hard request:

- `SessionManager.buildSessionContext()` for the restored branch.
- `convertToLlm()` for Pi message conversion.
- `AgentSession.systemPrompt` for the same system prompt.
- The same complete ordered tool definitions used during exploration.
- The same provider, model, authenticated `ModelRuntime`, and session ID.
- The same finalization user message used for soft finalization.

The direct request uses `ModelRuntime.streamSimple` with a dedicated `AbortSignal`, reasoning off,
named `submit_review` tool choice, and `maxRetries: 0`. It does not call `AgentSession.prompt`,
`steer`, `followUp`, automatic compaction, or the normal tool loop.

Before dispatch, pi-reviewer verifies that the selected model API and provider adapter can serialize
named forced tool choice. An unsupported route fails before network dispatch. Prompt wording is not
a fallback.

The response handler consumes one assistant stream and requires exactly one `submit_review` call.
It rejects these responses:

- No tool call.
- A different tool call.
- More than one tool call.
- A malformed `submit_review` call.
- A second accepted submission.
- Actionable content outside the required call.

For a valid call, the handler uses the shared submission gate and appends the hard-finalization user
message, actual assistant message, and deterministic tool result through public `SessionManager`
methods. It preserves usage, provider, model, response-model, stop-reason, and parent-chain data.

## Submission ownership

Refactor submission validation into one `ReviewSubmissionGate`. Exploration, soft finalization, and
hard finalization all use the same gate.

The gate:

- Validates the existing review schema and repository locations.
- Accepts a valid review with no findings.
- Accepts at most one review.
- Rejects malformed, repeated, or conflicting calls.
- Returns the normalized `ReviewSubmission` used by the existing output renderer.

The registered `submit_review` tool remains the AgentSession entry point. Hard finalization calls the
same gate directly after it validates the provider response.

### Validation normalization amendment

Provider schema support does not reliably enforce string-length limits. A valid hard response from
Qwen contained one 127-character finding title and was rejected after the only provider request had
completed. Earlier AgentSession evidence contained the same title-length failure and no other
`submit_review` schema failure class.

Use the public Pi `prepareArguments` hook before AgentSession tool validation. Use the same pure,
non-mutating preparation function and public Pi `validateToolArguments` path inside the shared gate
for direct hard calls. This keeps soft and hard conversion behavior equal.

Preparation can make only these deterministic metadata repairs:

- Shorten a title over 80 Unicode characters to 79 characters plus an ellipsis.
- Infer a missing or null numeric priority only from an exact `[P0]` through `[P3]` title prefix.

Keep all titles of 80 Unicode characters or fewer unchanged. Reject missing semantic content,
conflicting priorities, invalid confidence scores, invalid or reversed ranges, unsafe paths, unknown
fields, multiple calls, and actionable content outside the call. Do not add a repair request or
retry.

The native session preserves the raw assistant call. The accepted tool result and rendered output
contain the normalized review. The lifecycle receipt records only redacted repair counts, never the
original or normalized title text.

## Code changes

### Lifecycle and budgets

Create `src/review-lifecycle.ts` for state transitions, phase deadlines, quiescence, and terminal
ownership. Reduce `src/review-budget.ts` to policy parsing, warnings, trigger detection, and time
formatting.

Remove the current queue-based final prompt and retry flow. Remove every steer-before-abort path.
Delete `src/finalization.ts` after its old thinking-level and event behavior has no callers.

### Soft-phase guard

Replace the old one-way finalization event with a typed in-memory review-phase event. Update
`reviewer/extensions/review-guard.ts` so that:

- Exploration keeps the current read-only tool policy.
- Soft finalization blocks every tool except `submit_review` at execution time.
- The full active tool list stays unchanged.
- Hard finalization does not use extension tool execution.

The event is process-local and creates no persistent Pi state.

### Hard request

Create `src/forced-submission-turn.ts` for context assembly, capability checks, one direct stream,
response validation, usage collection, and native session appends. Keep this module narrow so a
future public transactional Pi turn API can replace its implementation.

Create `src/finalization-capabilities.ts` for model API and provider-adapter checks. Use only exports
from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`. Do not import private `dist`
paths, patch Pi objects, or fork Pi.

### Worker and parent cleanup

Update `src/worker.ts` to own the lifecycle controller and pass the existing `AgentSession`,
`SessionManager`, `ModelRuntime`, model, tools, and submission gate to each phase.

Update `src/worker-protocol.ts`, `src/runner.ts`, `src/args.ts`, and `src/types.ts` for the hard grace
and optional lifecycle-receipt path. Change the existing worker protocol version 1 in place. Do not
add a parallel protocol reader.

The hard request uses its own abort controller. At its deadline, the worker requests abort and waits
up to 30 seconds for settlement. A settled cancellation produces a normal explicit failure. If the
transport does not settle, the worker first flushes the session, metrics, and lifecycle receipt,
then reports `shutdown_ready` with `forcedExitRequired: true`. The parent sends `SIGTERM`. The parent
watchdog and `SIGKILL` remain last-resort defect handling and fail the canary gate.

### Metrics and receipts

Update `src/pi-events.ts` so direct hard-request usage is included exactly once in existing metrics.
Keep current route and model attestations.

Add a mode-0600 lifecycle receipt with schema version 1. It records safe operational facts:

- Lifecycle states, reasons, and timestamps.
- Queue-clear, abort-request, idle, and abort-settlement events.
- Pre-soft and soft-branch entry IDs.
- Prompt-prefix, context-prefix, and ordered-tool structural hashes.
- Reasoning mode and named tool-choice settings.
- Request dispatch, response-header, first-stream, last-stream, and settlement times when available.
- Stream event counts and byte or character counts, without content.
- Provider, model, response model, usage, and provider cache counters when supplied.
- Submission acceptance, accepted-call count, and redacted title-truncation and priority-inference
  counts.
- Session flush, receipt flush, worker shutdown readiness, and parent termination mode.

The receipt must not contain credentials, request headers, source text, prompt text, assistant text,
tool arguments, or raw private session content. It supplements the native session and current
receipts. It does not replace them.

## Prompt and cache contract

Soft and hard finalization use the same finalization user message. The hard branch is rooted before
soft finalization, so the hard request can reproduce the same system prompt, transcript prefix,
ordered full tool definitions, and final user tail.

Local structural hashes prove only local equality. Reasoning and tool-choice request fields can
still affect a provider cache key. pi-reviewer reports cache reuse only when the provider returns a
cache-read counter. It makes no cache claim from prompt identity alone.

## Context size

The direct hard request does not run hidden compaction. It uses any compaction summary that the
normal Pi session committed before `preSoftLeafId`.

pi-reviewer does not use a local byte or token estimate to block hard dispatch. Hugging Face
Inference Providers apply provider-specific chat templates, tool serialization, and tokenizers, so a
local estimate cannot enforce their exact context limit. The provider is the authority. pi-reviewer
sends the unchanged request once with no retry and records a provider context error if the request
does not fit. It does not change the prompt, drop tools, trim history, or create an unrecorded
summary.

This rule replaces the earlier local admission check. That check estimated tokens from serialized
JSON bytes and rejected compacted Qwen requests that the provider had already shown could fit.

Set a bounded hard-response token limit from the largest existing valid review artifact plus a
reviewed safety margin. Record the method and selected value in tests before implementation is
complete.

## Session contract

Normal Pi behavior appends all exploration and soft-finalization entries. The hard adapter appends
one user message, one real assistant response, and one tool result on a branch rooted at
`preSoftLeafId`.

The native session stays append-only and contains both finalization branches:

```text
preSoftLeafId
├── soft finalization branch
└── hard finalization branch
```

The session receipt, mode 0600, byte count, entry count, and SHA-256 checks remain authoritative.
The lifecycle receipt records both branch leaf IDs so an auditor can reconstruct each path.

## Tests

Add or update these tests before any live canary:

1. Pure lifecycle tests for every legal transition, illegal transition, race, timeout, and terminal
   state.
2. A regression fixture for the failed DeepSeek canary and its zero-submission, watchdog-kill path.
3. A real `AgentSession` integration test with a controlled stream and queued-message trap. It must
   prove queue clearing, abort settlement, continuation behavior, and idle detection.
4. Soft-finalization tests that keep the exploration thinking level and full tool list, block
   non-submit tool execution, and accept `submit_review` through the normal loop.
5. Branch tests that preserve the failed soft path and build hard context from `preSoftLeafId`.
6. Hard-payload tests for identical prompt and tool prefixes, reasoning off, named tool choice,
   `maxRetries: 0`, one dispatch, and the separate two-minute deadline. They must prove that local
   size estimates cannot block dispatch and that a real provider context error fails after exactly
   one request.
7. Submission-gate tests for a valid review, a valid empty review, missing calls, malformed calls,
   duplicate calls, multiple calls, other tools, prose-only output, title truncation, Unicode title
   length, priority inference, conflicting priority, and AgentSession conversion parity.
8. Native JSONL tests for hard user, assistant, and tool-result order, parent IDs, raw assistant
   arguments, normalized tool-result details, usage, route and model data, file mode, checksum, byte
   count, and entry count.
9. Lifecycle-receipt tests for schema, timestamp order, metric reconciliation, structural hashes,
   redacted normalization counts, terminal completeness, and absence of credentials, title text, or
   unique prompt markers.
10. Cancellation tests for immediate settlement, settlement after the old 30-second boundary,
    delayed settlement inside the allowance, ignored abort, late settlement without lifecycle
    events, late rejection, parent `SIGTERM`, and watchdog non-use.
11. A token-limit test based on measured valid review sizes.
12. Compatibility tests against the exact pinned Pi and Pi AI versions.

The real `AgentSession` test must replace the optimistic abort fake that allowed the failed design to
pass.

## One-task canary

After all local checks and review pass, build a package archive from the exact reviewed commit and
run one bounded Harbor trial for:

```text
vllm-project-vllm-pr-15998-a800045d0e24
```

Use the existing DeepSeek route, one task, one attempt, one active trial, the existing 10-minute
exploration budget, a two-minute soft phase, a two-minute hard phase, no automatic retry, native Pi
sessions, mock benchmark grading, and a reviewed cost ceiling below $5. Preserve the failed canary
artifacts.

The canary must verify:

- Exact package, provider route, requested model, and response model.
- The 10-minute exploration boundary and settled pre-soft quiescence.
- A normal soft-finalization request with unchanged thinking and full tools.
- One accepted `submit_review` call from either soft or hard finalization.
- If hard finalization runs, one forced request with reasoning off, named tool choice, no retry, and
  the full separate two-minute deadline.
- No other accepted finalization tool.
- Valid native session branches, receipts, metrics, checksums, byte counts, entry counts, and file
  modes.
- Settled cleanup or recorded parent `SIGTERM` after durable flush.
- No watchdog `SIGKILL`.
- No related remote sandbox after completion.

If soft finalization succeeds, hard finalization must not run. That result validates the production
short path but does not claim real-route hard-request evidence. The deterministic local integration
suite remains the required hard-path gate. Do not manipulate the canary prompt or timing to force a
hard phase.

Stop after this one canary. A failed gate does not authorize an automatic retry, package release,
adapter promotion, or broader benchmark run.

## Validation-repair canary

The lifecycle canary above remains historical evidence. After this amendment passes local checks,
review, and CI, run one bounded production-graded Harbor trial for
`immich-app-immich-pr-16893-d38f1f55f42d` with `Qwen/Qwen3.8-27B` through the Featherless Hugging
Face Inference Providers route. The temporary model manifest must include
`thinkingFormat: "qwen-chat-template"`.

Use one task, one attempt, no automatic retry, and a reviewed ceiling below $5. Preserve the prior
failed title-length canary. Require one accepted submission, no hard-request thinking, exactly one
forced `submit_review` call if hard finalization runs, redacted normalization evidence, durable
native session evidence, and no related active sandbox after cleanup. Record production grading but
do not use this one case to promote the model or adapter.

## Acceptance criteria

Implementation is ready for release consideration when:

- Exploration gets its configured budget.
- Soft finalization starts only after exploration is idle and gets its own full grace period.
- Hard finalization starts only after soft finalization is idle and gets its own full grace period.
- No code path queues a steering message before abort.
- Soft finalization uses normal Pi control flow and the exploration thinking level.
- Hard finalization disables reasoning and forces `submit_review` in the provider request.
- System prompt, transcript prefix, finalization user message, and ordered full tools match between
  the soft request and the pre-soft-rooted hard request.
- One gate accepts at most one valid review across all phases.
- Failed soft output remains available in the native session but does not enter hard context.
- Timeouts cancel, settle or flush, and leave durable terminal evidence.
- Normal timeout handling does not depend on watchdog `SIGKILL`.
- Existing review output, metrics, route/model attestation, native session, and failure semantics
  remain valid.
- Local checks, pi-reviewer review, CI, and the validation-repair canary pass.

## Verification

Run these local gates:

```bash
npm run check
npm run slophammer
git diff --check
pi-reviewer --base main
npx -y @simpledoc/simpledoc check
```

Do not run mutation tests as part of normal implementation or canary validation.

## Compatibility and migration

This is a hard runtime replacement. Remove the old finalization event, thinking-off hook, queued
steering flow, active-tool mutation, retry continuation, and optimistic abort fake. Do not keep a
legacy finalization path or fallback reader.

Keep the existing public review result and metrics formats. Extend the current CLI, worker request,
and receipt contracts in place. No migration of existing native sessions is needed; old sessions
remain historical evidence.

pi-reviewer stays a standalone pi-factory app. It does not register a global Pi extension or change
Pi core.

## Future Pi API

The ideal public Pi API is one transactional turn method that can:

- Clear queued messages and abort the active turn.
- Wait for idle.
- Apply request-local thinking and named tool choice.
- Limit accepted tools and accepted-call count.
- Disable automatic continuation.
- Persist the user, assistant, and tool-result messages through normal session handling.
- Return a durable request and cancellation receipt.

That upstream API is outside this task and outside pi-reviewer authority. The hard-finalization
adapter must stay narrow so it can later be replaced by such a public API without changing the
review lifecycle, submission gate, evidence schema, or canary contract.

## Non-goals

- Do not change Pi core, Pi private APIs, or external provider behavior.
- Do not change Harbor task data, benchmark scoring, or mock grading.
- Do not add a service, daemon, database, queue, or telemetry endpoint.
- Do not claim provider cache reuse without provider counters.
- Do not release the npm package or promote the Harbor adapter as part of implementation testing.
- Do not run more than the one authorized paid canary without new approval.
