import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import {
  HARD_CANCELLATION_ALLOWANCE_MS,
  REVIEW_QUIESCENCE_ALLOWANCE_MS,
  type FinalizationReason,
} from "./review-lifecycle.js";
import type { TimeWarning } from "./types.js";

export const DEFAULT_TIME_BUDGET_MS = 10 * 60_000;
export const DEFAULT_FINALIZATION_GRACE_MS = 2 * 60_000;
export const DEFAULT_HARD_FINALIZATION_GRACE_MS = 2 * 60_000;
export const WORKER_SHUTDOWN_ALLOWANCE_MS = 30_000;
const DEFAULT_WARNING_PERCENTAGES = [50, 25] as const;

export type ReviewTimePolicy = {
  readonly timeBudgetMs: number;
  readonly warningRemainingMs: readonly number[];
  readonly finalizationGraceMs: number;
  readonly hardFinalizationGraceMs: number;
};

type BudgetSession = Pick<AgentSession, "clearQueue" | "steer" | "subscribe">;

export function resolveReviewTimePolicy(
  timeBudgetMs = DEFAULT_TIME_BUDGET_MS,
  warnings?: readonly TimeWarning[],
  finalizationGraceMs = DEFAULT_FINALIZATION_GRACE_MS,
  hardFinalizationGraceMs = DEFAULT_HARD_FINALIZATION_GRACE_MS,
): ReviewTimePolicy {
  validatePolicyDuration(timeBudgetMs, "time budget");
  validatePolicyDuration(finalizationGraceMs, "finalization grace");
  validatePolicyDuration(hardFinalizationGraceMs, "hard finalization grace");
  const selectedWarnings =
    warnings ??
    DEFAULT_WARNING_PERCENTAGES.map((percentage) => ({
      kind: "percentage" as const,
      percentage,
    }));
  const remaining = selectedWarnings.map((warning) => {
    const value =
      warning.kind === "duration"
        ? warning.milliseconds
        : Math.round((timeBudgetMs * warning.percentage) / 100);
    if (!Number.isSafeInteger(value) || value <= 0 || value >= timeBudgetMs) {
      throw new Error(
        "time warnings must occur after review start and before the time budget ends",
      );
    }
    return value;
  });
  if (new Set(remaining).size !== remaining.length) {
    throw new Error("time warnings must be unique");
  }
  return {
    timeBudgetMs,
    warningRemainingMs: [...remaining].sort((left, right) => right - left),
    finalizationGraceMs,
    hardFinalizationGraceMs,
  };
}

export function workerWatchdogTimeoutMs(policy: ReviewTimePolicy): number {
  return (
    policy.timeBudgetMs +
    REVIEW_QUIESCENCE_ALLOWANCE_MS +
    policy.finalizationGraceMs +
    REVIEW_QUIESCENCE_ALLOWANCE_MS +
    policy.hardFinalizationGraceMs +
    HARD_CANCELLATION_ALLOWANCE_MS +
    WORKER_SHUTDOWN_ALLOWANCE_MS
  );
}

export class ReviewBudgetMonitor {
  private stopped = false;
  private requests = 0;
  private readonly timers: NodeJS.Timeout[];
  private readonly unsubscribe: () => void;

  constructor(
    private readonly session: BudgetSession,
    policy: ReviewTimePolicy,
    private readonly maxModelRequests: number | null,
    private readonly hasSubmission: () => boolean,
    private readonly trigger: (reason: FinalizationReason) => void,
  ) {
    this.timers = [
      setTimeout(() => {
        this.fire("time_budget");
      }, policy.timeBudgetMs),
      ...policy.warningRemainingMs.map((remainingMs) =>
        setTimeout(() => {
          this.warn(remainingMs);
        }, policy.timeBudgetMs - remainingMs),
      ),
    ];
    this.unsubscribe = session.subscribe((event) => {
      this.observe(event);
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.unsubscribe();
  }

  private warn(remainingMs: number): void {
    if (this.stopped || this.hasSubmission()) return;
    this.session.clearQueue();
    void this.session.steer(warningMessage(remainingMs)).catch(() => undefined);
  }

  private observe(event: AgentSessionEvent): void {
    if (this.stopped || event.type !== "message_end" || event.message.role !== "assistant") return;
    this.requests += 1;
    if (
      this.maxModelRequests !== null &&
      this.requests >= this.maxModelRequests &&
      event.message.stopReason === "toolUse"
    ) {
      this.fire("model_request_limit");
    }
  }

  private fire(reason: FinalizationReason): void {
    if (this.stopped || this.hasSubmission()) return;
    this.stop();
    this.trigger(reason);
  }
}

export function withBudgetNotice(prompt: string, policy: ReviewTimePolicy): string {
  return `${prompt}\n\nReview time budget: ${formatDuration(policy.timeBudgetMs)} for investigation, followed by up to ${formatDuration(policy.finalizationGraceMs)} for normal final submission and, only if needed, up to ${formatDuration(policy.hardFinalizationGraceMs)} for one forced submit_review request. You will receive time-remaining reminders. Submit early when further investigation is unlikely to change the result.`;
}

function warningMessage(remainingMs: number): string {
  return `[Review time budget] ${formatDuration(remainingMs)} remain. Prioritize actionable findings supported by current evidence. Submit now if further investigation is unlikely to change the review.`;
}

function validatePolicyDuration(milliseconds: number, label: string): void {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1_000 || milliseconds > 86_400_000) {
    throw new Error(`${label} must be between 1s and 24h`);
  }
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds % 3_600_000 === 0) return `${String(milliseconds / 3_600_000)}h`;
  if (milliseconds % 60_000 === 0) return `${String(milliseconds / 60_000)}m`;
  if (milliseconds % 1_000 === 0) return `${String(milliseconds / 1_000)}s`;
  return `${String(milliseconds)}ms`;
}
