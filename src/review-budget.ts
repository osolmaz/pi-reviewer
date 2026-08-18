import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { TimeWarning } from "./types.js";

export const DEFAULT_TIME_BUDGET_MS = 10 * 60_000;
export const DEFAULT_FINALIZATION_GRACE_MS = 2 * 60_000;
export const WORKER_SHUTDOWN_ALLOWANCE_MS = 30_000;
const DEFAULT_WARNING_PERCENTAGES = [50, 25] as const;
const SUBMIT_REVIEW_TOOL = "submit_review";

export type ReviewTimePolicy = {
  readonly timeBudgetMs: number;
  readonly warningRemainingMs: readonly number[];
  readonly finalizationGraceMs: number;
};

export type FinalizationReason = "time_budget" | "model_request_limit" | "missing_submission";

type ControlledSession = Pick<
  AgentSession,
  "abort" | "clearQueue" | "prompt" | "setActiveToolsByName" | "steer" | "subscribe"
>;

type PromptResult =
  | { readonly kind: "settled" }
  | { readonly kind: "failed"; readonly error: unknown };

type FinalPromptOutcome =
  | PromptResult
  | { readonly kind: "submitted" }
  | { readonly kind: "retry" };

type MonotonicNow = () => number;

type SubmissionSignal = {
  readonly submitted: Promise<void>;
  readonly detect: () => void;
};

const monotonicNow: MonotonicNow = () => performance.now();

export function resolveReviewTimePolicy(
  timeBudgetMs = DEFAULT_TIME_BUDGET_MS,
  warnings?: readonly TimeWarning[],
  finalizationGraceMs = DEFAULT_FINALIZATION_GRACE_MS,
): ReviewTimePolicy {
  validatePolicyDuration(timeBudgetMs, "time budget");
  validatePolicyDuration(finalizationGraceMs, "finalization grace");
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
  const unique = new Set(remaining);
  if (unique.size !== remaining.length) throw new Error("time warnings must be unique");
  return {
    timeBudgetMs,
    warningRemainingMs: [...remaining].sort((left, right) => right - left),
    finalizationGraceMs,
  };
}

export function workerWatchdogTimeoutMs(policy: ReviewTimePolicy): number {
  return policy.timeBudgetMs + policy.finalizationGraceMs + WORKER_SHUTDOWN_ALLOWANCE_MS;
}

export async function runReviewWithBudget(
  session: ControlledSession,
  prompt: string,
  policy: ReviewTimePolicy,
  maxModelRequests: number | null,
  hasSubmission: () => boolean,
  now: MonotonicNow = monotonicNow,
): Promise<FinalizationReason | null> {
  const reviewStartedAtMs = now();
  let triggerFinalization: (reason: FinalizationReason) => void = () => undefined;
  const finalizationTriggered = new Promise<FinalizationReason>((resolve) => {
    triggerFinalization = resolve;
  });
  let triggered = false;
  const trigger = (reason: FinalizationReason): void => {
    if (triggered || hasSubmission()) return;
    triggered = true;
    triggerFinalization(reason);
  };
  const warningTimers = scheduleWarnings(session, policy, () => triggered, hasSubmission);
  const deadlineTimer = setTimeout(() => {
    trigger("time_budget");
  }, policy.timeBudgetMs);
  let explorationStopped = false;
  const stopExploration = (): void => {
    if (explorationStopped) return;
    explorationStopped = true;
    clearTimeout(deadlineTimer);
    for (const timer of warningTimers) clearTimeout(timer);
  };
  const submission = createSubmissionSignal();
  let requests = 0;
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (hasSubmission()) submission.detect();
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    requests += 1;
    if (
      maxModelRequests !== null &&
      requests >= maxModelRequests &&
      event.message.stopReason === "toolUse"
    ) {
      trigger("model_request_limit");
    }
  });
  const initial = settledPrompt(session.prompt(withBudgetNotice(prompt, policy)));
  try {
    const outcome = await Promise.race([
      initial,
      finalizationTriggered.then((reason) => ({ kind: "triggered" as const, reason })),
    ]);
    if (outcome.kind === "settled") {
      stopExploration();
      if (hasSubmission()) return null;
      return await finalizeReview(
        session,
        finalDeadline(reviewStartedAtMs, policy, now),
        policy.finalizationGraceMs,
        "missing_submission",
        hasSubmission,
        submission.submitted,
        now,
      );
    }
    if (outcome.kind === "failed") throw outcome.error;
    stopExploration();
    const finalizationDeadlineMs = finalDeadline(reviewStartedAtMs, policy, now);
    return await finalizeActiveReview(
      session,
      finalizationDeadlineMs,
      policy.finalizationGraceMs,
      outcome.reason,
      hasSubmission,
      submission.submitted,
      now,
    );
  } finally {
    stopExploration();
    unsubscribe();
  }
}

function createSubmissionSignal(): SubmissionSignal {
  let detect: () => void = () => undefined;
  const submitted = new Promise<void>((resolve) => {
    detect = resolve;
  });
  return {
    submitted,
    detect: () => {
      detect();
    },
  };
}

function scheduleWarnings(
  session: Pick<ControlledSession, "clearQueue" | "steer">,
  policy: ReviewTimePolicy,
  isTriggered: () => boolean,
  hasSubmission: () => boolean,
): NodeJS.Timeout[] {
  return policy.warningRemainingMs.map((remainingMs) =>
    setTimeout(() => {
      if (isTriggered() || hasSubmission()) return;
      session.clearQueue();
      void session.steer(warningMessage(remainingMs)).catch(() => undefined);
    }, policy.timeBudgetMs - remainingMs),
  );
}

function finalDeadline(
  reviewStartedAtMs: number,
  policy: ReviewTimePolicy,
  now: MonotonicNow,
): number {
  const absoluteDeadlineMs = reviewStartedAtMs + policy.timeBudgetMs + policy.finalizationGraceMs;
  return Math.min(absoluteDeadlineMs, now() + policy.finalizationGraceMs);
}

async function finalizeActiveReview(
  session: ControlledSession,
  deadlineMs: number,
  graceMs: number,
  reason: FinalizationReason,
  hasSubmission: () => boolean,
  submitted: Promise<void>,
  now: MonotonicNow,
): Promise<FinalizationReason> {
  session.clearQueue();
  session.setActiveToolsByName([SUBMIT_REVIEW_TOOL]);
  const finalization = async (): Promise<void> => {
    await session.steer(finalizationPrompt(reason));
    if (hasSubmission()) return;
    const outcome = await Promise.race([
      settledPrompt(session.abort()),
      submitted.then(() => ({ kind: "submitted" as const })),
    ]);
    if (outcome.kind === "submitted" || hasSubmission()) return;
    if (outcome.kind === "failed") throw outcome.error;
    session.clearQueue();
    await promptFinalReview(session, reason, hasSubmission, submitted, deadlineMs, now);
  };
  await withFinalizationDeadline(finalization(), session, deadlineMs, graceMs, now);
  return reason;
}

async function finalizeReview(
  session: ControlledSession,
  deadlineMs: number,
  graceMs: number,
  reason: FinalizationReason,
  hasSubmission: () => boolean,
  submitted: Promise<void>,
  now: MonotonicNow,
): Promise<FinalizationReason> {
  session.clearQueue();
  session.setActiveToolsByName([SUBMIT_REVIEW_TOOL]);
  await withFinalizationDeadline(
    promptFinalReview(session, reason, hasSubmission, submitted, deadlineMs, now),
    session,
    deadlineMs,
    graceMs,
    now,
  );
  return reason;
}

async function promptFinalReview(
  session: Pick<ControlledSession, "abort" | "clearQueue" | "prompt" | "steer">,
  reason: FinalizationReason,
  hasSubmission: () => boolean,
  submitted: Promise<void>,
  deadlineMs: number,
  now: MonotonicNow,
): Promise<void> {
  const retryPrompt =
    "The first final submission attempt did not complete. Call submit_review now with the best result supported by the evidence already gathered. Do not return prose and do not investigate further.";
  const first = await waitForFinalPromptAttempt(
    session,
    finalizationPrompt(reason),
    submitted,
    deadlineMs,
    now,
  );
  if (first.kind === "submitted" || hasSubmission()) return;
  if (first.kind === "failed") throw first.error;
  if (first.kind === "settled") {
    await promptAndRequireSubmission(session, retryPrompt, hasSubmission);
    return;
  }
  await retryStalledFinalPrompt(session, retryPrompt, hasSubmission, submitted);
}

async function waitForFinalPromptAttempt(
  session: Pick<ControlledSession, "prompt">,
  prompt: string,
  submitted: Promise<void>,
  deadlineMs: number,
  now: MonotonicNow,
): Promise<FinalPromptOutcome> {
  let retryTimer: NodeJS.Timeout | undefined;
  const retry = new Promise<{ readonly kind: "retry" }>((resolve) => {
    retryTimer = setTimeout(
      () => {
        resolve({ kind: "retry" });
      },
      Math.max(1, Math.floor((deadlineMs - now()) / 2)),
    );
  });
  try {
    return await Promise.race([
      settledPrompt(session.prompt(prompt)),
      submitted.then(() => ({ kind: "submitted" as const })),
      retry,
    ]);
  } finally {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
  }
}

async function retryStalledFinalPrompt(
  session: Pick<ControlledSession, "abort" | "clearQueue" | "prompt" | "steer">,
  retryPrompt: string,
  hasSubmission: () => boolean,
  submitted: Promise<void>,
): Promise<void> {
  session.clearQueue();
  await session.steer(retryPrompt);
  if (hasSubmission()) return;
  const cancellation = await Promise.race([
    settledPrompt(session.abort()),
    submitted.then(() => ({ kind: "submitted" as const })),
  ]);
  if (cancellation.kind === "submitted" || hasSubmission()) return;
  if (cancellation.kind === "failed") throw cancellation.error;
  session.clearQueue();
  await promptAndRequireSubmission(session, retryPrompt, hasSubmission);
}

async function promptAndRequireSubmission(
  session: Pick<ControlledSession, "prompt">,
  prompt: string,
  hasSubmission: () => boolean,
): Promise<void> {
  await session.prompt(prompt);
  if (!hasSubmission()) throw new Error("review completed without submit_review");
}

async function withFinalizationDeadline(
  finalization: Promise<void>,
  session: Pick<AgentSession, "abort">,
  deadlineMs: number,
  graceMs: number,
  now: MonotonicNow,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        void session.abort().catch(() => undefined);
        reject(new Error(`review finalization exceeded ${formatDuration(graceMs)} grace period`));
      },
      Math.max(0, Math.ceil(deadlineMs - now())),
    );
  });
  try {
    await Promise.race([finalization, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function settledPrompt(prompt: Promise<void>): Promise<PromptResult> {
  return prompt.then(
    () => ({ kind: "settled" }),
    (error: unknown) => ({ kind: "failed", error }),
  );
}

function withBudgetNotice(prompt: string, policy: ReviewTimePolicy): string {
  return `${prompt}\n\nReview time budget: ${formatDuration(policy.timeBudgetMs)} for investigation, followed by up to ${formatDuration(policy.finalizationGraceMs)} for final submission. You will receive time-remaining reminders. Submit early when further investigation is unlikely to change the result.`;
}

function warningMessage(remainingMs: number): string {
  return `[Review time budget] ${formatDuration(remainingMs)} remain. Prioritize actionable findings supported by current evidence. Submit now if further investigation is unlikely to change the review.`;
}

function finalizationPrompt(reason: FinalizationReason): string {
  const cause =
    reason === "time_budget"
      ? "The investigation time budget has ended."
      : reason === "model_request_limit"
        ? "The model-request budget has ended."
        : "The review ended without a structured submission.";
  return `${cause} Investigation tools are disabled. Call submit_review with the best review supported by the evidence already gathered. Do not investigate further and do not return prose.`;
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
