# pi-reviewer

<p align="center">
  <img src="assets/cover.svg" alt="pi-reviewer: a Git diff goes in, prioritized P0 to P3 findings come out" width="880">
</p>

pi-reviewer is a standalone code review CLI built with [pi-factory](https://github.com/osolmaz/pi-factory). It reviews a Git diff in a fresh Pi process and returns prioritized P0 through P3 findings in the same shape as standalone `codex review`.

## Install

Install pi-reviewer from npm:

```bash
npm install -g @osolmaz/pi-reviewer
```

Or run it once with `npx`:

```bash
npx @osolmaz/pi-reviewer --base main
```

To build from source instead:

```bash
git clone https://github.com/osolmaz/pi-reviewer.git
cd pi-reviewer
npm ci
npm run build
npm link
```

## Configure a model

pi-reviewer has no model identifier in its review extension. Set the default outside the extension:

```bash
pi-reviewer config set model openai-codex/gpt-5.6-terra
pi-reviewer config set thinking high
```

The optional user config lives at `~/.config/pi-reviewer/config.json`. A command-line model or thinking level overrides it for one run:

```bash
pi-reviewer --model openai-codex/gpt-5.6-sol --thinking high --base main
```

pi-reviewer selects the provider implementation, model data, and existing authentication from the
main Pi profile:

```bash
pi-reviewer models gpt-5.6
```

The model in Reviewer config applies only to pi-reviewer. It does not change normal Pi's selected
provider or model. Prompts, tools, context files, sessions, repository policy, and review lifecycle
remain isolated.

Credentials stay in regular Pi's canonical `auth.json` or the selected provider's existing store. If
a selected provider package owns authentication, authenticate it through normal Pi. `pi-reviewer
login` does not create a single canonical credential as a fallback.

Hugging Face Inference Providers models work through regular Pi's Hugging Face OAuth from `pi-huggingface-oauth`, including route-suffixed model identifiers discovered by regular Pi. The reviewer registers the same OAuth provider in its isolated runtime and reads regular Pi's model catalog cache in place.

```bash
pi-reviewer config set model huggingface/moonshotai/Kimi-K3:fireworks-ai
pi-reviewer config set thinking high
```

If the canonical auth file has no Hugging Face credential yet, run `pi-reviewer login huggingface` or
regular Pi's Hugging Face login once. Both use the same canonical credential. Token refreshes stay
shared through that file, so the reviewer never holds its own copy.

For a model that is not yet in Pi's catalog, pass a strict model manifest. The selected provider and model must match the manifest. `apiKeyEnv` names an environment variable; the manifest does not contain the credential.

```json
{
  "version": 1,
  "provider": {
    "id": "example",
    "baseUrl": "https://api.example.com/v1",
    "apiKeyEnv": "EXAMPLE_API_KEY",
    "compat": { "supportsDeveloperRole": false }
  },
  "model": {
    "id": "organization/model:route",
    "name": "Model via pinned route",
    "reasoning": true,
    "input": ["text"],
    "contextWindow": 131072,
    "maxTokens": 32768,
    "cost": { "input": 0.1, "output": 0.2, "cacheRead": 0, "cacheWrite": 0 }
  }
}
```

```bash
pi-reviewer --model example/organization/model:route \
  --model-manifest ./model.json --base main
```

## Review

```bash
pi-reviewer --uncommitted
pi-reviewer --base main
pi-reviewer --commit <sha>
pi-reviewer "focus on cancellation safety"
```

The command writes progress to stderr and the final report to stdout. Use `--format json` to emit the validated Codex-compatible result object without terminal prose:

```bash
pi-reviewer --base main --format json > review.json
```

Use `--metrics-file` to record cumulative token use, estimated cost from the pinned model prices, and the provider, requested model, and response model reported by Pi. The file is refreshed after each model response, including during a review that later fails.

```bash
pi-reviewer --base main --format json --metrics-file ./review-metrics.json > review.json
```

Every review saves a native Pi JSONL session under `~/.local/state/pi-reviewer/sessions`. Sessions preserve messages, tool calls, tool results, model errors, and usage for later debugging, resume workflows, audits, or training-data preparation. They can contain reviewed source code and tool output, so protect and retain them like the repository itself.

Integrations can isolate a run with `--session-dir DIR` and request private receipts with `--session-receipt PATH` and `--lifecycle-receipt PATH`. The session receipt records the native session path, mode, byte count, entry count, and SHA-256 checksum. The lifecycle receipt records redacted phase, branch, request, usage, and cleanup evidence. It does not contain prompts, source text, assistant text, tool arguments, request headers, or credentials. Use `--no-session` only when persistence is deliberately unwanted; it cannot be combined with session output options.

pi-reviewer treats the time limit as an exploration budget. The default run gives the model 10 minutes to investigate, with reminders at 50% and 25% remaining. It then gives the model up to two minutes to submit through a normal Pi turn. If that turn does not submit, pi-reviewer makes one provider request with reasoning off and `submit_review` forced. The hard request gets a separate full two-minute limit.

Configure the three phase limits and repeatable warnings as needed:

```bash
pi-reviewer --base main \
  --time-budget 30m \
  --time-warning 50% \
  --time-warning 10m \
  --time-warning 5m \
  --finalization-grace 10m \
  --hard-finalization-grace 2m
```

Explicit warnings replace the defaults. Before each finalization phase, pi-reviewer clears queued messages, aborts the prior turn, and waits for Pi to report that the session is idle. Soft finalization keeps the selected thinking level, system prompt, context, and full ordered tool list. The review guard blocks all tool execution except `submit_review` without changing that list.

Hard finalization runs only when soft finalization does not submit. pi-reviewer keeps the failed soft branch in the native session, restores the branch point saved before soft finalization, and sends one direct request with the same prompt prefix and full tools. The request disables reasoning, forces the named `submit_review` tool, and has no automatic retry. One submission gate accepts at most one valid review across all phases. pi-reviewer reports provider cache reuse only when the provider returns a cache-read count.

`--max-model-requests N` uses the same finalization path after the Nth complete model response. Time and request limits cannot start competing finalization turns. Final review output must come through `submit_review`; raw JSON or prose is not accepted as a second submission protocol.

A successful review returns zero even when it has findings. Invalid targets, authentication failures, model failures, finalization failures, hard worker timeouts, or cancellation return nonzero. pi-reviewer never fabricates a clean result when the provider cannot finalize. A persistent session remains available after review or output-validation failure once model execution has started, including budget warnings and finalization prompts.

Review execution stays in a bounded child worker that is separate from the CLI process. Worker initialization has its own one-minute limit and does not consume review time; the parent starts its review watchdog only after the worker reports that model review is starting. Tools can inspect only the current checkout. Guarded command subprocesses receive a minimal environment without model-provider credentials. Mutation, network clients, shell operators, external Git helpers, and paths outside the checkout are blocked.

## Codex compatibility

pi-reviewer vendors Codex's review rubric and target prompt wording from commit `fa1d4c40d0e63eef2e0ba8a9e004ccd0a80b77f5`. [`UPSTREAM.md`](docs/UPSTREAM.md) records the exact sources and local changes. [`CODEX-COMPARISON.md`](docs/CODEX-COMPARISON.md) compares the commands and gives the same-branch verification procedure. [`CASE-STUDY.md`](docs/CASE-STUDY.md) records a paired comparison on two historical snapshots with known defects.

Both tools support custom instructions and the same review targets. A target can cover uncommitted changes or compare against either a base branch or one commit. Both return findings with a title, body, confidence, priority, location, correctness verdict, and overall confidence. pi-reviewer requires every finding to contain a P0 through P3 priority and fails closed on malformed output.

## Development

```bash
npm run check
npm run slophammer
```

Mutation testing is available through `npm run mutate` but is not part of normal completion checks.

## License

[MIT](LICENSE)
