# Changelog

## 0.1.5

### Changed

- Add Pi package gallery metadata.
- Keep reviewer-only extensions and prompts outside Pi's conventional package resource directories.

## 0.1.4

### Fixed

- Report the installed package version from validated package metadata instead of a hard-coded CLI value.

## 0.1.3

### Fixed

- Add the canonical GitHub repository URL required for npm provenance validation.

## 0.1.2

### Fixed

- Run npm trusted publishing with npm 11.5.1, the first CLI release that supports OpenID Connect publishing.

## 0.1.1

### Fixed

- Retry one stalled final-submission request halfway through the remaining grace period without creating a second Pi session or moving the absolute review deadline.
- Publish npm packages from GitHub Releases after validating the tag, package version, default-branch ancestry, and registry state.

## 0.1.0

First public release of pi-reviewer, a standalone code review CLI built with pi-factory. It reviews a Git diff in a fresh, isolated Pi process and returns prioritized P0 through P3 findings in the same shape as standalone `codex review`.

### Added

- `pi-reviewer` CLI with review targets for uncommitted changes, a base branch, or a commit.
- P0 through P3 findings with title, body, confidence, priority, location, correctness verdict, and overall confidence; fails closed on malformed output.
- Bounded child worker separate from the CLI process, with review watchdog, time budget, and `--max-model-requests` finalization.
- Guarded command subprocesses with a minimal environment and no model-provider credentials; mutation, network clients, shell operators, external Git helpers, and paths outside the checkout are blocked.
- Optional user config at `~/.config/pi-reviewer/config.json` for default model and thinking level.
- Shared canonical Pi `auth.json` for OpenAI Codex and Hugging Face Inference Providers models, including route-suffixed identifiers.
- Strict model manifest support for models not yet in Pi's catalog.
- Codex-compatible review rubric and target prompt wording, vendored from upstream commit `fa1d4c40d0e63eef2e0ba8a9e004ccd0a80b77f5`; see `docs/UPSTREAM.md`, `docs/CODEX-COMPARISON.md`, and `docs/CASE-STUDY.md`.
