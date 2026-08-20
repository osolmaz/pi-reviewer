import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { readWorkerRequest, validateWorkerRequest } from "../src/worker-protocol.js";

const REQUEST = {
  version: 1,
  cwd: "/repo",
  prompt: "Review",
  authPath: "/pi/auth.json",
  modelsPath: "/reviewer/models.json",
  configDir: "/reviewer",
  extensionPath: "/reviewer/review-guard.ts",
  systemPrompt: "Review code",
  provider: "openai-codex",
  model: "review-model",
  customModel: false,
  persistSession: true,
  sessionDir: "/reviewer/sessions",
  sessionReceipt: "/reviewer/session.json",
  lifecycleReceipt: "/reviewer/lifecycle.json",
  maxModelRequests: null,
  timeBudgetMs: 1_800_000,
  warningRemainingMs: [900_000, 300_000],
  finalizationGraceMs: 600_000,
  hardFinalizationGraceMs: 120_000,
  thinking: "high",
  tools: ["read", "review_shell"],
} as const;

describe("review worker protocol", () => {
  it("validates the bounded versioned request", async () => {
    expect(validateWorkerRequest(REQUEST)).toEqual(REQUEST);
    const input = Readable.from([JSON.stringify(REQUEST)]);
    await expect(readWorkerRequest(input)).resolves.toEqual(REQUEST);
  });

  it("rejects unknown fields and invalid values", () => {
    expect(() => validateWorkerRequest({ ...REQUEST, secret: "credential" })).toThrow(
      "unknown field",
    );
    expect(() => validateWorkerRequest({ ...REQUEST, thinking: "extreme" })).toThrow(
      "thinking level",
    );
    expect(() => validateWorkerRequest({ ...REQUEST, tools: [""] })).toThrow("nonempty strings");
    expect(() => validateWorkerRequest({ ...REQUEST, customModel: "yes" })).toThrow(
      "customModel is required",
    );
    expect(() => validateWorkerRequest({ ...REQUEST, persistSession: "yes" })).toThrow(
      "persistSession is required",
    );
    expect(() => validateWorkerRequest({ ...REQUEST, sessionDir: "" })).toThrow(
      "sessionDir is required",
    );
    expect(() => validateWorkerRequest({ ...REQUEST, sessionReceipt: "" })).toThrow(
      "sessionReceipt must be a nonempty string or null",
    );
    expect(() => validateWorkerRequest({ ...REQUEST, lifecycleReceipt: "" })).toThrow(
      "lifecycleReceipt must be a nonempty string or null",
    );
    expect(() => validateWorkerRequest({ ...REQUEST, maxModelRequests: 101 })).toThrow(
      "between 1 and 100",
    );
    expect(() => validateWorkerRequest({ ...REQUEST, timeBudgetMs: true })).toThrow("timeBudgetMs");
    expect(() =>
      validateWorkerRequest({ ...REQUEST, warningRemainingMs: [300_000, 900_000] }),
    ).toThrow("descending order");
    expect(() => validateWorkerRequest({ ...REQUEST, warningRemainingMs: [1_800_000] })).toThrow(
      "less than timeBudgetMs",
    );
    expect(() => validateWorkerRequest({ ...REQUEST, finalizationGraceMs: 999 })).toThrow(
      "finalizationGraceMs",
    );
    expect(() => validateWorkerRequest({ ...REQUEST, hardFinalizationGraceMs: 999 })).toThrow(
      "hardFinalizationGraceMs",
    );
  });

  it("bounds worker input before parsing", async () => {
    const input = Readable.from([Buffer.alloc(2 * 1024 * 1024 + 1, 0x20)]);
    await expect(readWorkerRequest(input)).rejects.toThrow("size limit");
  });
});
