---
title: Persist pi-reviewer sessions
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-10
---

# Persist pi-reviewer sessions

## Goal

pi-reviewer must save every review as a native Pi session by default. Harbor integrations must copy
that session into the trial artifacts before deleting a remote sandbox. These sessions are the
durable record for debugging, resuming reviews, auditing agent behavior, and preparing later
training datasets.

The current worker calls `SessionManager.inMemory(...)`. Harbor therefore retains the final review
and aggregate token metrics but loses the conversation, tool calls, retries, and intermediate
reasoning when the HF Sandbox is deleted.

## Requirements

- Use Pi's public `SessionManager` API and native JSONL format.
- Save one new session for every review by default.
- Use pi-reviewer's configured session directory rather than normal interactive Pi history.
- Keep an explicit `--no-session` option for callers that require ephemeral execution.
- Make the resolved session file available to integrations through a small receipt file without
  mixing metadata into review output.
- Write the receipt before model execution so interrupted reviews remain recoverable.
- Do not store credentials in the receipt or introduce a second session schema.
- Make Harbor use a fresh session directory for each trial.
- Download the native session on success, model failure, validation failure, cancellation, and
  timeout whenever a session file exists.
- Record the copied file's byte size and SHA-256 digest.
- Keep benchmark sessions separate from verifier references and judge evidence.

## Scope

### OnurPi

- Replace the in-memory session manager in `packages/pi-reviewer` with `SessionManager.create` by
  default.
- Add request fields and CLI options for an isolated session directory, a session receipt path, and
  explicit ephemeral operation.
- Add unit and integration tests for default persistence, opt-out behavior, receipt creation, and
  cleanup after failures.
- Document where sessions are stored and that they may contain reviewed source code and tool output.

### AACR-Bench Harbor

- Give every pi-reviewer trial a clean remote session directory.
- Request a receipt at a stable remote path.
- Download the session and an integrity manifest into the trial's `agent/` directory in a `finally`
  path.
- Reject missing sessions when the worker started far enough to create one; preserve earlier setup
  failures as ordinary failures.
- Test success and failure collection without exposing credentials or hidden references.

## Non-goals

- Do not change Pi core or Pi's persistent session format.
- Do not upload sessions to a central training store in this change.
- Do not transform native sessions into a training schema in the review worker.
- Do not add compatibility readers for the old sessionless behavior.
- Do not resume the sealed DeepSeek benchmark until the session artifact and runtime protocol are
  both corrected.

## Session contract

A normal review creates a native Pi JSONL file under pi-reviewer's configured session directory.
When `--session-receipt PATH` is present, pi-reviewer writes a mode-0600 JSON receipt with:

```json
{
  "version": 1,
  "sessionFile": "/absolute/path/to/native-session.jsonl"
}
```

The receipt contains no credential, model response, or source text. `--no-session` and
`--session-receipt` are mutually exclusive.

Harbor copies the native file to `agent/pi-session.jsonl` and writes `agent/pi-session.json`
containing the artifact version, byte size, and SHA-256 digest. The native session remains the
source of truth.

## Acceptance criteria

- A default local review creates exactly one native Pi session.
- `--no-session` creates none.
- The receipt points to the actual native session and is mode 0600.
- Session entries include user, assistant, and tool-result messages from the review.
- A failed or interrupted review leaves its partial native session available.
- Harbor downloads the session even when review output validation fails.
- Harbor integrity metadata matches the downloaded bytes.
- Existing review JSON and metrics contracts remain unchanged.
- No authentication or verifier-reference data appears in session receipts or integrity metadata.

## Verification

Run in OnurPi:

```bash
npm run check
npm run slophammer
git diff --check
pi-reviewer --base main
```

Run in AACR-Bench Harbor:

```bash
npm run check
npm run slophammer
git diff --check
```

Then run at least two diagnostic DeepSeek reviews on tasks that previously timed out in both sealed
runs. Confirm that each Harbor trial contains a valid `pi-session.jsonl`, inspect the tool-call
sequence, and ask a still-running diagnostic session why it has not finalized.
