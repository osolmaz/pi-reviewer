# @osolmaz/pi-reviewer

- Keep pi-reviewer as a standalone Pi Factory app. Do not register a global Pi extension or slash command.
- Keep reviewer-only extensions and prompts under `reviewer/`, outside Pi's conventional package resource directories.
- Keep model selection outside the review extension. Resolve command-line and user configuration before launch.
- Preserve read-only operation. Review tools must not edit files, run network clients, or invoke arbitrary shells.
- Treat Pi JSONL and model output as untrusted, bounded input.
- Preserve Codex review prompt and output provenance in `docs/UPSTREAM.md` and `LICENSE.codex`.
- Add or update tests for every behavior change.
- Run `npm run check` and `npm run slophammer` before finishing, followed by `git diff --check`.
- Keep mutation testing configured but manual unless the user explicitly requests it.
