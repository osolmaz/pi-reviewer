import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveReviewTimePolicy,
  ReviewBudgetMonitor,
  withBudgetNotice,
  workerWatchdogTimeoutMs,
} from "../src/review-budget.js";

const ASSISTANT_EVENT = {
  type: "message_end",
  message: {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "custom",
    model: "review-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  },
} satisfies AgentSessionEvent;

afterEach(() => {
  vi.useRealTimers();
});

describe("review time policy", () => {
  it("gives exploration, soft finalization, and hard finalization separate budgets", () => {
    const policy = resolveReviewTimePolicy(
      30 * 60_000,
      [
        { kind: "percentage", percentage: 50 },
        { kind: "duration", milliseconds: 10 * 60_000 },
      ],
      10 * 60_000,
      2 * 60_000,
    );
    expect(policy).toEqual({
      timeBudgetMs: 30 * 60_000,
      warningRemainingMs: [15 * 60_000, 10 * 60_000],
      finalizationGraceMs: 10 * 60_000,
      hardFinalizationGraceMs: 2 * 60_000,
    });
    const defaults = resolveReviewTimePolicy();
    expect(defaults).toEqual({
      timeBudgetMs: 10 * 60_000,
      warningRemainingMs: [5 * 60_000, 150_000],
      finalizationGraceMs: 2 * 60_000,
      hardFinalizationGraceMs: 2 * 60_000,
    });
    expect(workerWatchdogTimeoutMs(defaults)).toBe(17 * 60_000);
  });

  it("rejects duplicate and invalid phase budgets", () => {
    expect(() =>
      resolveReviewTimePolicy(60_000, [
        { kind: "percentage", percentage: 50 },
        { kind: "duration", milliseconds: 30_000 },
      ]),
    ).toThrow("unique");
    expect(() => resolveReviewTimePolicy(60_000, [], 2_000, 999)).toThrow(
      "hard finalization grace",
    );
  });

  it("describes both finalization phases in the exploration prompt", () => {
    const prompt = withBudgetNotice("Review", resolveReviewTimePolicy());
    expect(prompt).toContain("10m for investigation");
    expect(prompt).toContain("2m for normal final submission");
    expect(prompt).toContain("2m for one forced submit_review request");
  });
});

describe("exploration budget monitor", () => {
  it("clears stale warning messages and triggers the request boundary once", async () => {
    vi.useFakeTimers();
    let listener: (event: AgentSessionEvent) => void = () => undefined;
    const steers: string[] = [];
    const triggers: string[] = [];
    const monitor = new ReviewBudgetMonitor(
      {
        clearQueue: () => ({ steering: ["old"], followUp: [] }),
        steer: (message) => {
          steers.push(message);
          return Promise.resolve();
        },
        subscribe: (next) => {
          listener = next;
          return () => undefined;
        },
      },
      {
        timeBudgetMs: 10_000,
        warningRemainingMs: [5_000],
        finalizationGraceMs: 2_000,
        hardFinalizationGraceMs: 2_000,
      },
      1,
      () => false,
      (reason) => triggers.push(reason),
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(steers).toHaveLength(1);
    listener(ASSISTANT_EVENT);
    listener(ASSISTANT_EVENT);
    expect(triggers).toEqual(["model_request_limit"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(triggers).toHaveLength(1);
    monitor.stop();
  });

  it("does not warn or trigger after a submission", async () => {
    vi.useFakeTimers();
    let submitted = true;
    const triggers: string[] = [];
    const monitor = new ReviewBudgetMonitor(
      {
        clearQueue: () => ({ steering: [], followUp: [] }),
        steer: () => Promise.resolve(),
        subscribe: () => () => undefined,
      },
      {
        timeBudgetMs: 2_000,
        warningRemainingMs: [1_000],
        finalizationGraceMs: 2_000,
        hardFinalizationGraceMs: 2_000,
      },
      null,
      () => submitted,
      (reason) => triggers.push(reason),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(triggers).toEqual([]);
    submitted = false;
    monitor.stop();
  });
});
