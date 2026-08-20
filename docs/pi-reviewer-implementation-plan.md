# pi-reviewer implementation plan

## Goal

Maintain pi-reviewer as a standalone Pi Factory app in `osolmaz/pi-reviewer`. Its public interface is
the `pi-reviewer` terminal command.

```bash
pi-reviewer --uncommitted
pi-reviewer --base main
pi-reviewer --commit <sha>
pi-reviewer "focus on cancellation safety"
```

pi-reviewer owns target parsing, review prompts, read-only inspection, review finalization, structured
output, lifecycle receipts, and terminal rendering. It does not register a global Pi extension or
slash command.

pi-reviewer selects its own provider and model from a command-line override or its user config. A
review selection affects only that review process. It must not change the provider or model selected
in normal Pi.

The cross-repository provider and package design lives in the
[selective Pi profile inheritance plan](https://github.com/osolmaz/pi-factory/blob/main/docs/2026-08-21-selective-profile-inheritance-plan.md).
This document records the pi-reviewer part of that plan.

## User experience

The command accepts the same target forms as standalone Codex review:

```text
pi-reviewer --uncommitted
pi-reviewer --base <branch>
pi-reviewer --commit <sha> [--title <title>]
pi-reviewer <custom instructions>
```

Model selection stays outside the review extension. Users can set a persistent default or override
one run.

```text
pi-reviewer config set model openai-codex/<model-id>
pi-reviewer config set thinking high
pi-reviewer --model openai-codex/<other-model-id> --base main
```

Resolution order is the command-line override followed by user config. A model value includes its
provider. pi-reviewer fails before starting a review when neither source supplies a model.

The command also provides:

```text
pi-reviewer login [provider]
pi-reviewer models [search]
```

A normal review prints only the final report to stdout. Progress and errors go to stderr. SIGINT
stops the active worker and returns status 130.

Invalid arguments, missing authentication, unavailable models, malformed output, cancellation,
timeout, and worker failures return a nonzero status. A completed review returns zero even when it
contains findings.

## Pi Factory runtime

pi-reviewer uses Pi Factory's explicit, deny-by-default `inherit` contract for providers from the
main Pi profile.

For a provider with `source = "pi"`, pi-reviewer selects:

```toml
[inherit]
providers = ["openai-codex"]
```

It selects no inherited packages. Ambient extensions, skills, prompt templates, themes, context
files, commands, tools, hooks, and sessions remain disabled.

Pi Factory creates `ModelRuntime` with model and authentication state from the main profile. It loads
one enabled provider module when the selected provider has one, registers that provider before model
lookup and authentication checks, and creates the app-owned `DefaultResourceLoader` separately.

The selected provider can use the main profile's canonical authentication or its existing
provider-owned state. pi-reviewer never copies, returns, logs, rewrites, or directly reads credential
values.

pi-reviewer continues to choose the provider and model passed to its own `ModelRuntime`. It does not
write the main profile's `settings.json`, default provider, default model, model history, or any
normal Pi session state.

An explicit custom model manifest keeps its current separate runtime path. It does not inherit a Pi
provider and never acts as a fallback after an inherited provider fails.

## Worker input

Worker protocol version 1 uses a validated runtime union.

An inherited-provider request contains:

- the main agent directory;
- provider and model IDs;
- thinking level;
- the isolated app config and session paths;
- review prompt, tools, limits, and receipt paths.

It does not contain:

- a provider package name or module path;
- a switcher name or setting;
- an account ID;
- a credential or provider response;
- a provider vault path.

A custom-model request contains only its explicit custom runtime paths and model data. Mixed request
forms and unknown fields are errors.

For inherited requests, the parent stops generating or sending a source-Pi `models.json`. The app
config directory remains available for Reviewer settings and resources.

## Review runtime

The worker asks the Pi Factory SDK runtime for the selected provider and model. Pi Factory must
register any selected provider module before model lookup and authentication checks.

The Reviewer resource loader keeps:

- the Reviewer system prompt;
- the guarded review extension;
- the read-only tool set and `submit_review`;
- the app's settings manager and event bus.

It loads no resource from the main profile except the selected provider and its model data.

The complete three-phase review runs inside one Pi Factory `run` operation. The operation starts
before the first possible model request and stays active through:

- exploration;
- review tool calls;
- internal retries;
- compaction;
- soft finalization;
- hard finalization;
- forced submission turns;
- all automatic continuations.

The provider run finishes when no more model requests can occur. Handled failure and cancellation
finish it in `finally`. Session disposal and provider cleanup are idempotent.

For the Codex provider, confirmed usage exhaustion may select another account only before semantic
output. Once text, thinking, or a tool call starts, one account remains selected for the rest of the
review.

## Authentication and models

`pi-reviewer models` constructs the same inherited provider before listing models. The command shows
models available to that provider but does not update normal Pi's model selection.

Authentication checks use the selected provider's existing state. When a selected provider module
owns authentication and has no general login operation, `pi-reviewer login` reports that the main Pi
profile manages authentication. It does not call native login to create a single fallback
credential.

A built-in provider with no enabled provider module may continue to use Pi's normal login after the
user explicitly requests it.

Persistent Reviewer defaults remain in:

```text
~/.config/pi-reviewer/config.json
```

The file contains only model and thinking preferences. It has no credentials, account IDs, or
provider settings.

## Review behavior

The reviewer prompt uses the Codex review rubric recorded in `docs/UPSTREAM.md` and `LICENSE.codex`.
The review must inspect the target diff and report only actionable defects introduced by that target.
Every finding includes a P0 through P3 priority and a precise code location.

Malformed output is a command failure. It never becomes a clean verdict.

## Read-only policy

pi-reviewer remains read-only. Its tools may inspect repository files and bounded Git state. They
must reject file mutation, network clients, arbitrary shell execution, process control, paths outside
the checkout, and unsafe shell syntax.

The review must not edit files, apply fixes, publish comments, open pull requests, or merge changes.

## Sessions and receipts

Normal reviews use in-memory or explicitly requested Reviewer sessions. They never inherit normal Pi
sessions.

Review lifecycle and session receipts remain under Reviewer-owned paths with user-only permissions.
They must preserve exactly-once submission, finalization evidence, and forced-exit evidence. Provider
state must not enter a receipt or session entry.

## Failure behavior

pi-reviewer stops with a clear error for:

- a missing or disabled selected provider;
- duplicate provider declarations;
- provider import or construction failure;
- a missing selected model;
- missing authentication;
- invalid worker input;
- review timeout or cancellation;
- malformed review output;
- missing `submit_review` submission;
- receipt or cleanup failure.

After Pi Factory selects an enabled provider module, pi-reviewer never retries with Pi's built-in
provider or another credential path.

## Tests

Tests must cover:

- worker input validation and redaction;
- provider and model selection without normal Pi settings writes;
- one unrelated synthetic provider to prove the integration is generic;
- Pi built-in providers with no enabled provider module;
- explicit custom model manifests;
- model listing after provider registration;
- provider-owned authentication without fallback login;
- no inherited extensions, skills, prompt templates, themes, contexts, commands, tools, or sessions;
- read-only tool allow and deny cases;
- target parsing and Git resolution;
- bounded model and tool output handling;
- clean reviews and P0 through P3 findings;
- malformed, empty, duplicate, and truncated output;
- tools, retries, compaction, soft and hard finalization, and forced submission inside one provider
  run;
- timeout, SIGINT, transport failure, forced exit, and idempotent cleanup;
- exactly-once submission and lifecycle receipts;
- concurrent reviews with independent in-memory provider state;
- no credential copy, rewrite, fallback credential, or provider-specific output.

Keep mutation testing configured but manual unless the user explicitly requests it.

## Rollout

Update pi-reviewer only after compatible Pi Factory and OnurPi changes are released and installed.
Pin the required Pi Factory version. Replace the direct source-Pi runtime path instead of retaining it
as a fallback.

Run synthetic tests before a bounded real-profile test. The real test must confirm:

- `pi-reviewer models` sees the selected provider's models;
- a one-run model override changes only the review;
- `pi-reviewer --base main` authenticates through the inherited provider;
- one account stays selected after semantic output;
- no normal Pi setting, credential file, tracked file, or unrelated session changes;
- no child process remains.

After local checks and review pass, run CI and install the released package. Then rerun the review
that was blocked by missing `openai-codex` authentication.

## Contract impact

- **Session state:** normal Pi sessions and normal Pi model selection do not change. Reviewer
  sessions remain isolated.
- **Other persistent data:** Reviewer may update its own model and thinking defaults only through
  explicit config commands. It does not create or copy provider credentials.
- **Pi internals:** none.
- **Public APIs:** Pi Factory manifest version 1, Pi Factory's SDK runtime, Pi `SettingsManager`,
  `DefaultPackageManager`, `DefaultResourceLoader`, `ModelRuntime`, provider registration, and
  documented resource flags.

## Acceptance criteria

The work is complete when pi-reviewer can select its own `openai-codex` model, load the provider
implementation and authentication already selected by the main profile, and run a complete
three-phase review without loading unrelated profile resources.

The selected model applies only to pi-reviewer. Normal Pi's provider, model, settings, sessions, and
credentials remain unchanged. Provider routing can move accounts only before semantic output, and
one account stays selected through tools, retries, compaction, and finalization.

Failures in provider loading, authentication, target resolution, model execution, output parsing,
cancellation, or cleanup return a nonzero status and never produce a clean verdict or native-provider
fallback.
