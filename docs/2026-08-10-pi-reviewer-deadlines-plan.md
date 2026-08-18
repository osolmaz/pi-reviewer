---
title: Add cooperative Pi Reviewer deadlines
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-10
---

# Add cooperative Pi Reviewer deadlines

## Goal

Pi Reviewer must stop treating its review limit as a wall-clock kill. A configured deadline should
help the model manage its remaining time, stop new investigation when the exploration budget ends,
and give the model a separate chance to submit the best review supported by evidence already in the
session.

The current parent process terminates the Pi worker after 20 minutes and also terminates it after
two minutes without an event. Both paths can discard a useful review trajectory without asking the
model to finalize. The sealed DeepSeek study showed this repeatedly.

## Requirements

- Replace the fixed 20-minute kill with a configurable exploration budget.
- Support repeated warning thresholds expressed as time remaining or a percentage remaining.
- Tell the model about its total budget before investigation starts.
- Deliver threshold warnings through Pi's public steering API rather than changing tool output.
- Coalesce stale warnings when several thresholds pass during one long model response.
- At the exploration deadline, clear pending warnings, disable investigation tools, queue the
  finalization request, and only then abort unfinished investigation.
- Give finalization its own configurable grace period.
- Use a typed terminating `submit_review` tool so malformed prose or extra JSON cannot become the
  machine-readable result.
- Keep a hard child-process deadline only as a last infrastructure failsafe after exploration and
  finalization should already have completed.
- Preserve native Pi sessions on every path.
- Keep model-request limits and time limits under one idempotent finalization controller so they
  cannot race.
- Never fabricate a review when the provider or worker cannot complete finalization.

## Interface

Pi Reviewer will support:

```text
--time-budget 30m
--time-warning 50%
--time-warning 10m
--time-warning 5m
--finalization-grace 10m
```

Warnings are repeatable. A percentage means the percentage of the exploration budget remaining. A
duration means that exact duration remaining. Explicit warnings replace the default 50% and 25%
remaining warnings.

The default is a 10-minute exploration budget followed by at most two minutes for finalization. At
12 minutes the worker aborts model execution, records an explicit finalization failure, flushes its
session and metrics, and exits. A fixed 30-second parent allowance exists only to reap a worker that
freezes while shutting down; it is not model time and is not exposed as review configuration.

## Runtime design

A worker-local controller owns this state machine:

```text
EXPLORING
  warning threshold -> queue or replace one steering reminder
  valid submission  -> COMPLETE
  request limit     -> FINALIZING
  time budget       -> FINALIZING
  no submission     -> FINALIZING

FINALIZING
  valid submission  -> COMPLETE
  grace exhausted   -> INFRASTRUCTURE_FAILURE
```

The controller records one monotonic start time immediately before the initial review prompt and
derives the exploration and finalization deadlines from it. At that boundary the worker emits one
validated `review_started` protocol event, and only then does the parent arm its review watchdog.
Worker initialization has its own fixed one-minute bound, so startup cannot consume review or
shutdown time and cannot hang indefinitely. Warning messages say how much time remains and ask the
model to prioritize actionable findings or finalize early. They are normal Pi user messages and
therefore remain visible in the native session.

On finalization, the controller first clears queued reminders, leaves only `submit_review` active,
and queues the finalization prompt with `AgentSession.steer`. The review guard checks Pi's current
active-tool set on every `tool_call`, so investigation tools from the active run's older tool
snapshot are blocked after this transition. The controller then requests cancellation without making
prompt delivery depend on `AgentSession.abort` becoming idle. If cancellation reaches idle first,
the controller removes any stale queued copy and prompts directly. If that direct final-submission
request remains pending halfway through the remaining grace period, the controller queues one retry
before aborting the stalled request. A queued retry can submit while cancellation is pending; if
cancellation reaches idle first, the controller prompts directly again. A missing tool submission
receives one corrective prompt if time remains. Transition and retry work consume the same two-minute
finalization window rather than moving the deadline. The parent process force-kills the complete
worker process group only when it has not exited within the separate 30-second shutdown allowance.

The submission tool validates the existing public review schema and ends the agent turn with
`terminate: true`. Pi Reviewer's external text and JSON output stay unchanged.

## Scope

- Add strict duration and warning parsing to the Pi Reviewer CLI.
- Extend worker protocol version 1 in place with normalized deadline fields.
- Add a worker-local budget controller with an injectable clock for deterministic tests.
- Add the typed terminating submission tool and worker result event.
- Remove the two-minute event-based termination path.
- Update the review system prompt, README, CLI help, tests, and integration fixtures.

## Non-goals

- Do not change Pi core, private APIs, or Pi's native session format.
- Do not put countdown text in every tool result.
- Do not guarantee a model result after a provider, network, or process failure that prevents all
  finalization requests.
- Do not create a second Pi session or a separate finalizer session.
- Do not restart or change the AACR-Bench study in this implementation.
- Do not retain raw-text parsing as a second model-submission protocol.

## Contract impact

- **Session state:** Warning messages, the finalization prompt, and the `submit_review` tool result
  become normal native Pi session entries.
- **Other persistent data:** No new persistent store or schema is introduced. Existing review
  output, metrics, and session receipts keep their formats.
- **Pi internals:** None.
- **Public API:** `AgentSession.prompt`, `steer`, `abort`, `clearQueue`, `setActiveToolsByName`, and
  `subscribe`; SDK custom tools; and terminating tool results.

## Acceptance criteria

- A warning fires once at each configured threshold and uses the normalized remaining time.
- Several thresholds crossed during one model turn produce only the most urgent pending warning.
- A review submitted before the deadline cancels all timers.
- The finalization steer is queued before exploration cancellation begins.
- A queued `submit_review` result can complete finalization while `AgentSession.abort` remains
  pending.
- A direct final-submission request that remains pending halfway through the available grace receives
  one same-session retry without moving the absolute deadline.
- The exploration deadline cannot terminate the worker before a finalization attempt.
- Deadline and request-limit triggers cause one finalization transition, even when simultaneous.
- Finalization has no investigation tools and can use only `submit_review`, including when the
  active run retains an older tool-schema snapshot.
- A valid submission produces the existing `ReviewOutput` and CLI formats.
- Text without `submit_review` is rejected and receives one bounded corrective prompt.
- Finalization-grace expiry stops model execution at the derived absolute deadline and fails
  explicitly.
- The worker normally flushes the native session and metrics after that failure.
- The parent review watchdog starts only after one validated worker start marker.
- Worker initialization fails separately if that marker does not arrive within one minute.
- A worker still alive 30 seconds after the review deadline is force-killed as a complete process
  group.
- Parent signals still terminate the complete process group.
- Existing model usage and route-attestation metrics remain unchanged.

## Verification

```bash
npm run check
npm run slophammer
git diff --check
pi-reviewer --base main
```

Run a bounded real-model smoke with a short warning schedule. Confirm that the native session
contains the initial budget notice, a warning or finalization prompt, and a validated
`submit_review` result. Do not run mutation testing as part of normal completion.
