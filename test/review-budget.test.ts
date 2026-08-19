import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveReviewTimePolicy,
  runReviewWithBudget,
  workerWatchdogTimeoutMs,
} from "../src/review-budget.js";

const TOOL_EVENT: AgentSessionEvent = {
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
};

afterEach(() => {
  vi.useRealTimers();
});

describe("review time policy", () => {
  it("normalizes percentage and duration warnings", () => {
    const policy = resolveReviewTimePolicy(
      30 * 60_000,
      [
        { kind: "percentage", percentage: 50 },
        { kind: "duration", milliseconds: 10 * 60_000 },
        { kind: "duration", milliseconds: 5 * 60_000 },
      ],
      10 * 60_000,
    );
    expect(policy).toEqual({
      timeBudgetMs: 30 * 60_000,
      warningRemainingMs: [15 * 60_000, 10 * 60_000, 5 * 60_000],
      finalizationGraceMs: 10 * 60_000,
    });
    expect(workerWatchdogTimeoutMs(policy)).toBe(40 * 60_000 + 30_000);
    expect(resolveReviewTimePolicy(1_000).warningRemainingMs).toEqual([500, 250]);
    const defaults = resolveReviewTimePolicy();
    expect(defaults).toEqual({
      timeBudgetMs: 10 * 60_000,
      warningRemainingMs: [5 * 60_000, 150_000],
      finalizationGraceMs: 2 * 60_000,
    });
    expect(workerWatchdogTimeoutMs(defaults)).toBe(12 * 60_000 + 30_000);
  });

  it("rejects duplicate and out-of-range warnings", () => {
    expect(() =>
      resolveReviewTimePolicy(60_000, [
        { kind: "percentage", percentage: 50 },
        { kind: "duration", milliseconds: 30_000 },
      ]),
    ).toThrow("unique");
    expect(() =>
      resolveReviewTimePolicy(60_000, [{ kind: "duration", milliseconds: 60_000 }]),
    ).toThrow("before the time budget ends");
  });
});

describe("review budget controller", () => {
  it("coalesces warnings and cancels timers after an early submission", async () => {
    vi.useFakeTimers();
    let submitted = false;
    let finishInitial: () => void = () => undefined;
    const steers: string[] = [];
    let clears = 0;
    const review = runReviewWithBudget(
      {
        abort: () => Promise.resolve(),
        clearQueue: () => {
          clears += 1;
          return { steering: [], followUp: [] };
        },
        prompt: () =>
          new Promise<void>((resolve) => {
            finishInitial = resolve;
          }),
        setActiveToolsByName: () => undefined,
        steer: (message) => {
          steers.push(message);
          return Promise.resolve();
        },
        subscribe: () => () => undefined,
      },
      "Review",
      {
        timeBudgetMs: 100_000,
        warningRemainingMs: [50_000, 25_000],
        finalizationGraceMs: 20_000,
      },
      null,
      () => submitted,
    );

    await vi.advanceTimersByTimeAsync(50_000);
    expect(steers.at(-1)).toContain("50s remain");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(steers.at(-1)).toContain("25s remain");
    expect(clears).toBe(2);
    submitted = true;
    finishInitial();
    await expect(review).resolves.toBeNull();
    await vi.runAllTimersAsync();
    expect(steers).toHaveLength(2);
  });

  it("enters cache-preserving finalization before the final request", async () => {
    vi.useFakeTimers();
    let submitted = false;
    let finishInitial: () => void = () => undefined;
    const prompts: string[] = [];
    const steers: string[] = [];
    const tools: string[][] = [];
    const transitions: string[] = [];
    let aborts = 0;
    const review = runReviewWithBudget(
      {
        abort: () => {
          aborts += 1;
          transitions.push("abort");
          finishInitial();
          return Promise.resolve();
        },
        clearQueue: () => ({ steering: [], followUp: [] }),
        prompt: (message) => {
          prompts.push(message);
          if (prompts.length === 1) {
            return new Promise<void>((resolve) => {
              finishInitial = resolve;
            });
          }
          submitted = true;
          return Promise.resolve();
        },
        setActiveToolsByName: (names) => {
          tools.push(names);
          transitions.push("restrict-tools");
        },
        steer: (message) => {
          steers.push(message);
          transitions.push("steer");
          return Promise.resolve();
        },
        subscribe: () => () => undefined,
      },
      "Review",
      { timeBudgetMs: 60_000, warningRemainingMs: [], finalizationGraceMs: 20_000 },
      null,
      () => submitted,
      {
        enterFinalization: () => {
          transitions.push("enter-finalization");
        },
      },
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(review).resolves.toBe("time_budget");
    expect(aborts).toBe(1);
    expect(tools).toEqual([]);
    expect(transitions).toEqual(["enter-finalization", "steer", "abort"]);
    expect(prompts[0]).toContain("Review time budget: 1m");
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain("time budget has ended");
    expect(prompts[1]).toContain("time budget has ended");
  });
});

describe("review budget finalization retry", () => {
  it("retries a stalled final submission within the same grace period", async () => {
    vi.useFakeTimers();
    let submitted = false;
    let finishInitial: () => void = () => undefined;
    let promptCount = 0;
    let aborts = 0;
    const steers: string[] = [];
    const never = new Promise<void>(() => undefined);
    const review = runReviewWithBudget(
      {
        abort: () => {
          aborts += 1;
          finishInitial();
          return Promise.resolve();
        },
        clearQueue: () => ({ steering: [], followUp: [] }),
        prompt: () => {
          promptCount += 1;
          if (promptCount === 1) {
            return new Promise<void>((resolve) => {
              finishInitial = resolve;
            });
          }
          if (promptCount === 2) return never;
          submitted = true;
          return Promise.resolve();
        },
        setActiveToolsByName: () => undefined,
        steer: (message) => {
          steers.push(message);
          return Promise.resolve();
        },
        subscribe: () => () => undefined,
      },
      "Review",
      { timeBudgetMs: 10_000, warningRemainingMs: [], finalizationGraceMs: 4_000 },
      null,
      () => submitted,
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(promptCount).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(review).resolves.toBe("time_budget");
    expect(aborts).toBe(2);
    expect(promptCount).toBe(3);
    expect(steers).toHaveLength(2);
    expect(steers[1]).toContain("first final submission attempt did not complete");
  });

  it("accepts the retry submission while cancellation remains pending", async () => {
    vi.useFakeTimers();
    let submitted = false;
    let finishInitial: () => void = () => undefined;
    let listener: (event: AgentSessionEvent) => void = () => undefined;
    let promptCount = 0;
    let aborts = 0;
    let steers = 0;
    const never = new Promise<void>(() => undefined);
    const review = runReviewWithBudget(
      {
        abort: () => {
          aborts += 1;
          finishInitial();
          return aborts === 1 ? Promise.resolve() : never;
        },
        clearQueue: () => ({ steering: [], followUp: [] }),
        prompt: () => {
          promptCount += 1;
          if (promptCount === 1) {
            return new Promise<void>((resolve) => {
              finishInitial = resolve;
            });
          }
          return never;
        },
        setActiveToolsByName: () => undefined,
        steer: () => {
          steers += 1;
          if (steers === 2) {
            setTimeout(() => {
              submitted = true;
              listener(TOOL_EVENT);
            }, 100);
          }
          return Promise.resolve();
        },
        subscribe: (next) => {
          listener = next;
          return () => undefined;
        },
      },
      "Review",
      { timeBudgetMs: 10_000, warningRemainingMs: [], finalizationGraceMs: 4_000 },
      null,
      () => submitted,
    );

    await vi.advanceTimersByTimeAsync(12_100);
    await expect(review).resolves.toBe("time_budget");
    expect(aborts).toBe(2);
    expect(steers).toBe(2);
  });
});

describe("review budget finalization failures", () => {
  it("shares finalization between request and time budgets", async () => {
    vi.useFakeTimers();
    let submitted = false;
    let finishInitial: () => void = () => undefined;
    let listener: (event: AgentSessionEvent) => void = () => undefined;
    let finalPrompts = 0;
    let steers = 0;
    const review = runReviewWithBudget(
      {
        abort: () => {
          finishInitial();
          return Promise.resolve();
        },
        clearQueue: () => ({ steering: [], followUp: [] }),
        prompt: () => {
          if (finalPrompts === 0) {
            finalPrompts += 1;
            return new Promise<void>((resolve) => {
              finishInitial = resolve;
            });
          }
          submitted = true;
          finalPrompts += 1;
          return Promise.resolve();
        },
        setActiveToolsByName: () => undefined,
        steer: () => {
          steers += 1;
          return Promise.resolve();
        },
        subscribe: (next) => {
          listener = next;
          return () => undefined;
        },
      },
      "Review",
      { timeBudgetMs: 60_000, warningRemainingMs: [], finalizationGraceMs: 20_000 },
      1,
      () => submitted,
    );

    listener(TOOL_EVENT);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(review).resolves.toBe("model_request_limit");
    expect(finalPrompts).toBe(2);
    expect(steers).toBe(1);
  });

  it("accepts a queued submission while exploration abort remains stuck", async () => {
    vi.useFakeTimers();
    let submitted = false;
    let listener: (event: AgentSessionEvent) => void = () => undefined;
    const never = new Promise<void>(() => undefined);
    const review = runReviewWithBudget(
      {
        abort: () => never,
        clearQueue: () => ({ steering: [], followUp: [] }),
        prompt: () => never,
        setActiveToolsByName: () => undefined,
        steer: () => {
          setTimeout(() => {
            submitted = true;
            listener(TOOL_EVENT);
          }, 500);
          return Promise.resolve();
        },
        subscribe: (next) => {
          listener = next;
          return () => undefined;
        },
      },
      "Review",
      { timeBudgetMs: 10_000, warningRemainingMs: [], finalizationGraceMs: 2_000 },
      null,
      () => submitted,
    );

    await vi.advanceTimersByTimeAsync(10_500);
    await expect(review).resolves.toBe("time_budget");
  });

  it("queues finalization before a stuck exploration abort reaches the absolute deadline", async () => {
    vi.useFakeTimers();
    let aborts = 0;
    const steers: string[] = [];
    const never = new Promise<void>(() => undefined);
    const review = runReviewWithBudget(
      {
        abort: () => {
          aborts += 1;
          return never;
        },
        clearQueue: () => ({ steering: [], followUp: [] }),
        prompt: () => never,
        setActiveToolsByName: () => undefined,
        steer: (message) => {
          steers.push(message);
          return Promise.resolve();
        },
        subscribe: () => () => undefined,
      },
      "Review",
      { timeBudgetMs: 10_000, warningRemainingMs: [], finalizationGraceMs: 2_000 },
      null,
      () => false,
    );

    const rejection = expect(review).rejects.toThrow("finalization exceeded 2s");
    await vi.advanceTimersByTimeAsync(12_000);
    await rejection;
    expect(aborts).toBe(2);
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain("time budget has ended");
  });

  it("fails explicitly when finalization grace expires", async () => {
    vi.useFakeTimers();
    let finishInitial: () => void = () => undefined;
    let promptCount = 0;
    const review = runReviewWithBudget(
      {
        abort: () => {
          finishInitial();
          return Promise.resolve();
        },
        clearQueue: () => ({ steering: [], followUp: [] }),
        prompt: () => {
          promptCount += 1;
          if (promptCount === 1) {
            return new Promise<void>((resolve) => {
              finishInitial = resolve;
            });
          }
          return new Promise<void>(() => undefined);
        },
        setActiveToolsByName: () => undefined,
        steer: () => Promise.resolve(),
        subscribe: () => () => undefined,
      },
      "Review",
      { timeBudgetMs: 10_000, warningRemainingMs: [], finalizationGraceMs: 5_000 },
      null,
      () => false,
    );

    const rejection = expect(review).rejects.toThrow("finalization exceeded 5s");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
  });
});
