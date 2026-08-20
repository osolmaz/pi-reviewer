# Upstream review behavior

pi-reviewer uses the standalone review behavior from OpenAI Codex as its compatibility reference.

| Item       | Value                                                  |
| ---------- | ------------------------------------------------------ |
| Repository | https://github.com/openai/codex                        |
| Commit     | `fa1d4c40d0e63eef2e0ba8a9e004ccd0a80b77f5`             |
| Retrieved  | 2026-07-31                                             |
| License    | Apache-2.0, copied in [`LICENSE.codex`](LICENSE.codex) |

Reviewed source files:

- `codex-rs/cli/src/main.rs`
- `codex-rs/exec/src/cli.rs`
- `codex-rs/exec/src/lib.rs`
- `codex-rs/core/src/session/handlers.rs`
- `codex-rs/core/src/session/review.rs`
- `codex-rs/core/src/tasks/review.rs`
- `codex-rs/prompts/src/review_request.rs`
- `codex-rs/prompts/templates/review/rubric.md`
- `codex-rs/protocol/src/protocol.rs`
- `codex-rs/protocol/src/review_format.rs`

Copied material:

- `reviewer/prompts/review-system.md` starts from Codex's review rubric.
- `src/git-target.ts` uses the target prompt text from `review_request.rs`.
- `src/review-output.ts` implements the review output shape from the rubric and protocol.

Local changes:

- The system prompt tells the model to use pi-reviewer's guarded `review_shell` tool.
- Every finding must include a numeric P0 through P3 priority. Codex allows an omitted priority, but pi-reviewer requires one so terminal output is always prioritized.
- Malformed output is a command failure. It is never treated as a clean review.
- pi-reviewer uses a fresh Pi Factory app process instead of a Codex child task.
- Model selection comes from `--model` or pi-reviewer's user config. The review extension contains no model identifier.
- Repository inspection uses a smaller read-only tool set and rejects shell operators, network clients, mutation attempts and paths outside the checkout.
