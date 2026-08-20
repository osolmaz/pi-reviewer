# Codex review comparison

pi-reviewer follows standalone `codex review` at OpenAI Codex commit `fa1d4c40d0e63eef2e0ba8a9e004ccd0a80b77f5`. The two commands share the same review targets and rubric, plus the same priorities and structured result fields. Their runtime implementations differ because pi-reviewer runs as an independent Pi Factory app.

| Behavior               | `codex review`                              | `pi-reviewer`                                    |
| ---------------------- | ------------------------------------------- | ------------------------------------------------ |
| Uncommitted changes    | `--uncommitted`                             | `--uncommitted`                                  |
| Base branch            | `--base <branch>`                           | `--base <branch>`                                |
| Commit                 | `--commit <sha>`                            | `--commit <sha>`                                 |
| Custom instructions    | Positional prompt                           | Positional prompt                                |
| Isolation              | Fresh Codex review task                     | Fresh child Pi worker with an in-memory session  |
| Model selection        | Codex `review_model` or active model        | External user config or `--model provider/model` |
| Thinking level         | Codex configuration                         | External user config or `--thinking`             |
| Project instructions   | Codex project instruction discovery         | Pi `AGENTS.md` context discovery                 |
| Repository tools       | Codex review sandbox and shell policy       | Pi read tools plus guarded `review_shell`        |
| Network tools          | Disabled                                    | Unavailable                                      |
| Findings               | P0 through P3 with locations and confidence | Same, with numeric priority required             |
| Overall result         | Correctness, explanation, confidence        | Same                                             |
| Malformed model output | Review fallback or parse failure            | Nonzero command failure; never clean             |

## Verified shared behavior

The test suite checks the following compatibility points:

- After normalizing line endings, `reviewer/prompts/review-system.md` matches the pinned Codex rubric byte for byte after removing one documented `review_shell` instruction. The upstream SHA-256 is `ec60e7f36a1d1c2679ce095c0205ecc56f7dd8fb57707a13ef362072390f219f`.
- Target prompts for uncommitted changes, merge bases, unrelated branches, titled commits and custom instructions match `codex-rs/prompts/src/review_request.rs`.
- Result validation uses Codex's `findings`, `overall_correctness`, `overall_explanation`, and `overall_confidence_score` fields.
- Every finding keeps Codex's title, body, confidence score, numeric priority, absolute path, and line range.
- Terminal rendering preserves visible `[P0]`, `[P1]`, `[P2]`, or `[P3]` labels.

## Intentional differences

pi-reviewer requires an external model selection. No model identifier appears in the review extension. Provider and model choice therefore belongs to the app configuration.

pi-reviewer uses a narrower repository tool set. It rejects shell composition, mutating Git commands, external helpers, network clients, process-executing search options, symlink escapes, and paths outside the checkout.

Malformed output fails the command. This differs from Codex's display fallback and prevents an invalid response from being mistaken for a clean review.

## Same-branch comparison

For a release candidate, run both tools against the same checkout and base:

```bash
codex review -c 'model="gpt-5.6-terra"' -c 'model_reasoning_effort="high"' --base main
pi-reviewer --model openai-codex/gpt-5.6-terra --thinking high --base main
```

Compare target resolution, finding priorities, locations, correctness verdicts, and command failures. Model reviews are stochastic, so identical findings are not required. A missing P0 or P1 from either tool must be investigated before release.

## Historical comparison

[`CASE-STUDY.md`](CASE-STUDY.md) records a paired run on two historical OnurPi pull request snapshots with defects confirmed by later fixes. It includes wall times, finding overlap, unique findings, known misses, and the limits of the small sample.
