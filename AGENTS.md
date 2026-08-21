# @osolmaz/pi-reviewer

- Keep pi-reviewer as a standalone pi-factory app. Do not register a global Pi extension or slash command.
- Keep reviewer-only extensions and prompts under `reviewer/`, outside Pi's conventional package resource directories.
- Keep model selection outside the review extension. Resolve command-line and user configuration before launch.
- Preserve read-only operation. Review tools must not edit files, run network clients, or invoke arbitrary shells.
- Treat Pi JSONL and model output as untrusted, bounded input.
- Preserve Codex review prompt and output provenance in `docs/UPSTREAM.md` and `LICENSE.codex`.
- Add or update tests for every behavior change.
- Do not use local byte or token estimates to block a provider request. Pi compaction may use estimates, but only the provider can enforce its exact context limit.
- Preserve the compacted session branch for hard finalization. If the request is too large, send it once with no retry and record the provider error instead of trimming context or tools.
- Normalize only safe submission metadata before validation: shorten overlong titles and infer a missing priority only from an exact `[P0]` through `[P3]` title prefix. Preserve the raw assistant call, use the same public Pi validation path in every phase, and reject all semantic or conflicting errors.
- Keep quiescence bounded with enough margin for provider abort settlement. Do not record late abort or idle events after the quiescence deadline or terminal transition.
- Run `npm run check` and `npm run slophammer` before finishing, followed by `git diff --check`.
- Keep mutation testing configured but manual unless the user explicitly requests it.
