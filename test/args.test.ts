import { describe, expect, it } from "vitest";

import {
  parseArgs,
  parseModel,
  validateDuration,
  validateOutputFormat,
  validateThinking,
  validateTimeWarning,
} from "../src/args.js";
import { resolveSelection } from "../src/cli.js";

describe("review arguments", () => {
  it("parses every Codex review target", () => {
    expect(parseArgs(["--uncommitted"], "/repo")).toMatchObject({
      kind: "review",
      request: { cwd: "/repo", target: { kind: "uncommitted" } },
    });
    expect(
      parseArgs([
        "--base",
        "main",
        "--model",
        "openai-codex/reviewer",
        "--model-manifest",
        "/tmp/model.json",
        "--metrics-file",
        "/tmp/metrics.json",
        "--session-dir",
        "/tmp/sessions",
        "--session-receipt",
        "/tmp/session.json",
        "--lifecycle-receipt",
        "/tmp/lifecycle.json",
        "--max-model-requests",
        "12",
        "--time-budget",
        "30m",
        "--time-warning",
        "50%",
        "--time-warning",
        "5m",
        "--finalization-grace",
        "10m",
        "--hard-finalization-grace",
        "2m",
        "--thinking",
        "high",
        "--format",
        "json",
      ]),
    ).toMatchObject({
      request: {
        target: { kind: "base", branch: "main" },
        model: "openai-codex/reviewer",
        modelManifest: "/tmp/model.json",
        metricsFile: "/tmp/metrics.json",
        sessionDir: "/tmp/sessions",
        sessionReceipt: "/tmp/session.json",
        lifecycleReceipt: "/tmp/lifecycle.json",
        maxModelRequests: 12,
        timeBudgetMs: 1_800_000,
        timeWarnings: [
          { kind: "percentage", percentage: 50 },
          { kind: "duration", milliseconds: 300_000 },
        ],
        finalizationGraceMs: 600_000,
        hardFinalizationGraceMs: 120_000,
        thinking: "high",
        format: "json",
      },
    });
    expect(parseArgs(["--commit", "abc", "--title", "Fix it"])).toMatchObject({
      request: { target: { kind: "commit", sha: "abc", title: "Fix it" } },
    });
    expect(parseArgs(["focus", "on", "cancellation"])).toMatchObject({
      request: { target: { kind: "custom", instructions: "focus on cancellation" } },
    });
  });

  it("parses config, login, models, help, and version commands", () => {
    expect(parseArgs(["config", "show"])).toEqual({ kind: "config-show" });
    expect(parseArgs(["config", "reset"])).toEqual({ kind: "config-reset" });
    expect(parseArgs(["config", "set", "model", "openai/model"])).toEqual({
      kind: "config-set-model",
      model: "openai/model",
    });
    expect(parseArgs(["config", "set", "thinking", "xhigh"])).toEqual({
      kind: "config-set-thinking",
      thinking: "xhigh",
    });
    expect(parseArgs(["login", "openai-codex"])).toEqual({
      kind: "login",
      provider: "openai-codex",
    });
    expect(parseArgs(["models", "terra"])).toEqual({ kind: "models", search: "terra" });
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
  });

  it("rejects ambiguous and malformed arguments", () => {
    expect(() => parseArgs([])).toThrow("usage: pi-reviewer");
    expect(() => parseArgs(["--base"])).toThrow("--base requires a value");
    expect(() => parseArgs(["--base", "main", "--uncommitted"])).toThrow("mutually exclusive");
    expect(() => parseArgs(["--base", "main", "instructions"])).toThrow("mutually exclusive");
    expect(() => parseArgs(["--title", "title", "--base", "main"])).toThrow("--title requires");
    expect(() => parseArgs(["--unknown"])).toThrow("unknown option");
    expect(() => parseArgs(["config", "set", "other", "x"])).toThrow("config key");
    expect(() => parseArgs(["config", "set", "auth", "pi"])).toThrow("config key");
    expect(() => parseArgs(["config", "set"])).toThrow("usage");
    expect(() => parseArgs(["login", "a", "b"])).toThrow("usage");
    expect(() => parseArgs(["models", "a", "b"])).toThrow("usage");
    expect(parseArgs(["--base", "main", "--no-session"])).toMatchObject({
      request: { persistSession: false },
    });
    expect(() =>
      parseArgs(["--base", "main", "--no-session", "--session-receipt", "/tmp/session"]),
    ).toThrow("cannot be combined");
    expect(() =>
      parseArgs(["--base", "main", "--no-session", "--session-dir", "/tmp/sessions"]),
    ).toThrow("cannot be combined");
    expect(() =>
      parseArgs(["--base", "main", "--no-session", "--lifecycle-receipt", "/tmp/lifecycle"]),
    ).toThrow("cannot be combined");
  });

  it("validates model and thinking values", () => {
    expect(parseModel("huggingface/org/model:route")).toEqual({
      provider: "huggingface",
      model: "org/model:route",
    });
    expect(() => parseModel("missing-provider")).toThrow("provider/model");
    expect(() => parseModel("/missing")).toThrow("provider/model");
    expect(() => parseArgs(["--base", "main", "--max-model-requests", "0"])).toThrow(
      "must be an integer",
    );
    expect(() => parseArgs(["--base", "main", "--max-model-requests", "101"])).toThrow(
      "at most 100",
    );
    expect(validateDuration("30m")).toBe(1_800_000);
    expect(validateTimeWarning("25%")).toEqual({ kind: "percentage", percentage: 25 });
    expect(() => validateDuration("30")).toThrow("positive ms, s, m, or h");
    expect(() => validateDuration("999ms")).toThrow("between 1s and 24h");
    expect(() => validateTimeWarning("100%")).toThrow("between 1% and 99%");
    expect(() => validateThinking("extreme")).toThrow("thinking must be one of");
    expect(validateOutputFormat("json")).toBe("json");
    expect(() => validateOutputFormat("xml")).toThrow("format must be one of");
  });

  it("resolves external model defaults without a model in the extension", () => {
    expect(
      resolveSelection(undefined, undefined, {
        version: 1,
        auth: "pi",
        model: "openai-codex/gpt-review",
        thinking: "high",
      }),
    ).toEqual({ provider: "openai-codex", model: "gpt-review", thinking: "high" });
    expect(
      resolveSelection("openai/other", "low", {
        version: 1,
        auth: "pi",
        model: "openai-codex/gpt-review",
        thinking: "high",
      }),
    ).toEqual({ provider: "openai", model: "other", thinking: "low" });
    expect(() => resolveSelection(undefined, undefined, { version: 1, auth: "pi" })).toThrow(
      "No review model configured",
    );
  });
});
