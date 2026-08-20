import { readFile } from "node:fs/promises";

import { createEventBus, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  listenForReviewPhase,
  REVIEW_PHASE_EVENT as GUARD_PHASE_EVENT,
} from "../reviewer/extensions/review-guard.js";
import { LifecycleEvidence } from "../src/lifecycle-receipt.js";
import { runThreePhaseReview } from "../src/review-controller.js";
import {
  quiesceReviewSession,
  REVIEW_PHASE_EVENT,
  ReviewLifecycle,
} from "../src/review-lifecycle.js";
import { ReviewSubmissionGate } from "../src/submit-review.js";

afterEach(() => {
  vi.useRealTimers();
});

// eslint-disable-next-line max-lines-per-function
describe("review lifecycle", () => {
  it("uses the shared typed phase channel", () => {
    expect(REVIEW_PHASE_EVENT).toBe(GUARD_PHASE_EVENT);
    const eventBus = createEventBus();
    const phase = listenForReviewPhase(eventBus);
    expect(phase.current()).toBe("exploring");
    eventBus.emit(REVIEW_PHASE_EVENT, "soft_finalizing");
    expect(phase.current()).toBe("soft_finalizing");
    eventBus.emit(REVIEW_PHASE_EVENT, "hard_finalizing");
    expect(phase.current()).toBe("hard_finalizing");
    eventBus.emit(REVIEW_PHASE_EVENT, "invalid");
    expect(phase.current()).toBe("hard_finalizing");
    phase.dispose();
  });

  it("accepts every legal success path", () => {
    const exploration = new ReviewLifecycle();
    exploration.transition("accepted", "submitted");
    exploration.transition("shutdown_ready", "done");

    const soft = new ReviewLifecycle();
    soft.transition("quiescing_before_soft", "deadline");
    soft.transition("soft_finalizing", "idle");
    soft.transition("accepted", "submitted");
    soft.transition("shutdown_ready", "done");

    const hard = new ReviewLifecycle();
    hard.transition("quiescing_before_soft", "deadline");
    hard.transition("soft_finalizing", "idle");
    hard.transition("quiescing_before_hard", "missing");
    hard.transition("hard_finalizing", "idle");
    hard.transition("accepted", "submitted");
    hard.transition("shutdown_ready", "done");

    expect(exploration.state).toBe("shutdown_ready");
    expect(soft.state).toBe("shutdown_ready");
    expect(hard.state).toBe("shutdown_ready");
  });

  it("accepts both quiescence failure paths and hard failure", () => {
    for (const setup of [
      (lifecycle: ReviewLifecycle) => {
        lifecycle.transition("quiescing_before_soft", "deadline");
      },
      (lifecycle: ReviewLifecycle) => {
        lifecycle.transition("quiescing_before_soft", "deadline");
        lifecycle.transition("soft_finalizing", "idle");
        lifecycle.transition("quiescing_before_hard", "missing");
      },
      (lifecycle: ReviewLifecycle) => {
        lifecycle.transition("quiescing_before_soft", "deadline");
        lifecycle.transition("soft_finalizing", "idle");
        lifecycle.transition("quiescing_before_hard", "missing");
        lifecycle.transition("hard_finalizing", "idle");
      },
    ]) {
      const lifecycle = new ReviewLifecycle();
      setup(lifecycle);
      lifecycle.transition("failed", "failure");
      lifecycle.transition("shutdown_ready", "done");
      expect(lifecycle.state).toBe("shutdown_ready");
    }
  });

  it("rejects illegal transitions and lets only one terminal owner win", () => {
    const lifecycle = new ReviewLifecycle();
    expect(() => {
      lifecycle.transition("hard_finalizing", "skip");
    }).toThrow("illegal");
    expect(lifecycle.tryAccept("first")).toBe(true);
    expect(lifecycle.tryAccept("second")).toBe(false);
    expect(lifecycle.tryFail("late failure")).toBe(false);
    lifecycle.transition("shutdown_ready", "done");
    expect(() => {
      lifecycle.transition("failed", "late");
    }).toThrow("illegal");
    expect(lifecycle.transitions.filter((entry) => entry.to === "accepted")).toHaveLength(1);
  });

  it("keeps the failed DeepSeek canary as a zero-submission watchdog regression fixture", async () => {
    const fixture = JSON.parse(
      await readFile(new URL("./fixtures/failed-deepseek-canary.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(fixture).toMatchObject({
      task: "vllm-project-vllm-pr-15998-a800045d0e24",
      partialThinkingCharacters: 282_800,
      acceptedSubmissionCalls: 0,
      entriesAfterFinalizationMessage: 0,
      parentTermination: "watchdog_sigkill",
      artifactsPreserved: true,
    });
  });

  it("records real queue clearing, abort settlement, and idle confirmation", async () => {
    const lifecycle = new ReviewLifecycle();
    lifecycle.transition("quiescing_before_soft", "deadline");
    await quiesceReviewSession(
      {
        clearQueue: () => ({ steering: ["warning"], followUp: ["later"] }),
        abort: () => Promise.resolve(),
        waitForIdle: () => Promise.resolve(),
        isIdle: true,
      },
      lifecycle,
      1_000,
    );
    expect(lifecycle.events.map((event) => event.kind)).toEqual([
      "queue_cleared",
      "abort_requested",
      "abort_settled",
      "idle_confirmed",
    ]);
  });

  it("fails bounded quiescence when abort settlement is ignored", async () => {
    vi.useFakeTimers();
    const lifecycle = new ReviewLifecycle();
    lifecycle.transition("quiescing_before_soft", "deadline");
    const quiescence = quiesceReviewSession(
      {
        clearQueue: () => ({ steering: [], followUp: [] }),
        abort: () => new Promise<void>(() => undefined),
        waitForIdle: () => Promise.resolve(),
        isIdle: false,
      },
      lifecycle,
      1_000,
    );
    const rejection = expect(quiescence).rejects.toThrow("did not become idle");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
  });

  it("runs hard finalization only after both idle confirmations", async () => {
    const calls: string[] = [];
    const sessionManager = SessionManager.inMemory("/repo");
    sessionManager.appendMessage({ role: "user", content: "explore", timestamp: 1 });
    const session = {
      prompt: (prompt: string) => {
        calls.push(`prompt:${prompt.startsWith("review") ? "explore" : "soft"}`);
        return Promise.resolve();
      },
      subscribe: () => () => undefined,
      clearQueue: () => {
        calls.push("clear");
        return { steering: [], followUp: [] };
      },
      abort: () => {
        calls.push("abort");
        return Promise.resolve();
      },
      waitForIdle: () => {
        calls.push("idle");
        return Promise.resolve();
      },
      isIdle: true,
    } as unknown as AgentSession;
    const lifecycle = new ReviewLifecycle();
    const evidence = new LifecycleEvidence(lifecycle, null);
    const hardFinalize = vi.fn(() => {
      calls.push("hard");
      return Promise.resolve({
        kind: "failed" as const,
        error: new Error("hard failure"),
        forcedExitRequired: false,
      });
    });
    const result = await runThreePhaseReview(
      {
        session,
        sessionManager,
        eventBus: createEventBus(),
        policy: {
          timeBudgetMs: 60_000,
          warningRemainingMs: [],
          finalizationGraceMs: 60_000,
          hardFinalizationGraceMs: 60_000,
        },
        maxModelRequests: null,
        gate: new ReviewSubmissionGate("/repo"),
        lifecycle,
        evidence,
        recordStablePrefix: () => undefined,
        hardFinalize,
      },
      "review",
    );
    expect(result.forcedExitRequired).toBe(false);
    expect(result.error?.message).toBe("hard failure");
    expect(hardFinalize).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      "prompt:explore",
      "clear",
      "abort",
      "idle",
      "prompt:soft",
      "clear",
      "abort",
      "idle",
      "hard",
    ]);
  });

  it("keeps submissions that settle during either quiescence boundary", async () => {
    for (const acceptOnAbort of [1, 2]) {
      const sessionManager = SessionManager.inMemory("/repo");
      sessionManager.appendMessage({ role: "user", content: "explore", timestamp: 1 });
      const gate = new ReviewSubmissionGate("/repo");
      let aborts = 0;
      const session = {
        prompt: () => Promise.resolve(),
        subscribe: () => () => undefined,
        clearQueue: () => ({ steering: [], followUp: [] }),
        abort: () => {
          aborts += 1;
          if (aborts === acceptOnAbort) {
            gate.accept({
              findings: [],
              overall_correctness: "patch is correct",
              overall_explanation: "No defect found.",
              overall_confidence_score: 0.9,
            });
          }
          return Promise.resolve();
        },
        waitForIdle: () => Promise.resolve(),
        isIdle: true,
      } as unknown as AgentSession;
      const lifecycle = new ReviewLifecycle();
      const hardFinalize = vi.fn(() => Promise.reject(new Error("hard finalization must not run")));
      const result = await runThreePhaseReview(
        {
          session,
          sessionManager,
          eventBus: createEventBus(),
          policy: {
            timeBudgetMs: 60_000,
            warningRemainingMs: [],
            finalizationGraceMs: 60_000,
            hardFinalizationGraceMs: 60_000,
          },
          maxModelRequests: null,
          gate,
          lifecycle,
          evidence: new LifecycleEvidence(lifecycle, null),
          recordStablePrefix: () => undefined,
          hardFinalize,
        },
        "review",
      );
      expect(result).toEqual({ forcedExitRequired: false });
      expect(gate.acceptedCallCount).toBe(1);
      expect(hardFinalize).not.toHaveBeenCalled();
      expect(lifecycle.transitions.map((entry) => entry.to)).toContain("accepted");
    }
  });

  it("records ordered timestamps and operational events", () => {
    let milliseconds = 0;
    const lifecycle = new ReviewLifecycle(() => new Date((milliseconds += 1)));
    lifecycle.transition("quiescing_before_soft", "deadline");
    lifecycle.record({ kind: "queue_cleared", steeringCount: 1, followUpCount: 2 });
    const transitions = lifecycle.transitions;
    const started = transitions[0];
    const quiescing = transitions[1];
    if (started === undefined || quiescing === undefined) throw new Error("missing transitions");
    expect(started.timestamp < quiescing.timestamp).toBe(true);
    expect(lifecycle.events).toMatchObject([
      {
        kind: "queue_cleared",
        phase: "quiescing_before_soft",
        steeringCount: 1,
        followUpCount: 2,
      },
    ]);
  });
});
