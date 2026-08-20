import type { AgentSession, EventBus, SessionManager } from "@earendil-works/pi-coding-agent";

import type { ForcedSubmissionResult } from "./forced-submission-turn.js";
import type { LifecycleEvidence } from "./lifecycle-receipt.js";
import { ReviewBudgetMonitor, type ReviewTimePolicy, withBudgetNotice } from "./review-budget.js";
import {
  quiesceReviewSession,
  REVIEW_PHASE_EVENT,
  ReviewLifecycle,
  reviewFinalizationPrompt,
  type FinalizationReason,
  waitForReviewIdle,
} from "./review-lifecycle.js";
import type { ReviewSubmissionGate } from "./submit-review.js";

export type ReviewControllerResult = {
  readonly forcedExitRequired: boolean;
  readonly error?: Error;
};

type PromptOutcome =
  | { readonly kind: "settled" }
  | { readonly kind: "failed"; readonly error: Error };

type ReviewControllerInput = {
  readonly session: AgentSession;
  readonly sessionManager: SessionManager;
  readonly eventBus: EventBus;
  readonly policy: ReviewTimePolicy;
  readonly maxModelRequests: number | null;
  readonly gate: ReviewSubmissionGate;
  readonly lifecycle: ReviewLifecycle;
  readonly evidence: LifecycleEvidence;
  readonly recordStablePrefix: (preSoftLeafId: string, finalizationPrompt: string) => void;
  readonly hardFinalize: (
    preSoftLeafId: string,
    finalizationPrompt: string,
  ) => Promise<ForcedSubmissionResult>;
};

// Keep the three ordered phases in one function so every transition remains visible.
// eslint-disable-next-line complexity, max-lines-per-function -- Keep all three ordered phase transitions visible in one controller.
export async function runThreePhaseReview(
  input: ReviewControllerInput,
  prompt: string,
): Promise<ReviewControllerResult> {
  let triggerFinalization: (reason: FinalizationReason) => void = () => undefined;
  const triggered = new Promise<FinalizationReason>((resolve) => {
    triggerFinalization = resolve;
  });
  const monitor = new ReviewBudgetMonitor(
    input.session,
    input.policy,
    input.maxModelRequests,
    () => input.gate.submission !== undefined,
    triggerFinalization,
  );
  const exploration = settlePrompt(input.session.prompt(withBudgetNotice(prompt, input.policy)));

  let reason: FinalizationReason;
  try {
    const outcome = await Promise.race([
      exploration,
      triggered.then((value) => ({ kind: "triggered" as const, reason: value })),
      input.gate.accepted.then(() => ({ kind: "accepted" as const })),
    ]);
    monitor.stop();
    if (outcome.kind === "accepted" || input.gate.submission !== undefined) {
      return await finishAccepted(input, "exploration_submission");
    }
    reason =
      outcome.kind === "triggered"
        ? outcome.reason
        : outcome.kind === "failed"
          ? "model_error"
          : "missing_submission";
  } finally {
    monitor.stop();
  }

  input.lifecycle.transition("quiescing_before_soft", reason);
  const preSoftQuiescence = await quiesce(input, "pre_soft_quiescence_failed");
  if (preSoftQuiescence !== undefined) return preSoftQuiescence;
  if (input.gate.hasSubmission()) {
    input.lifecycle.transition(
      "soft_finalizing",
      "exploration_submission_settled_during_quiescence",
    );
    return await finishAccepted(input, "exploration_submission");
  }
  void exploration.then(
    () => undefined,
    () => undefined,
  );

  const preSoftLeafId = input.sessionManager.getLeafId();
  if (preSoftLeafId === null) {
    return failAndFinish(
      input,
      new Error("review session has no pre-soft leaf"),
      false,
      "missing_pre_soft_leaf",
    );
  }
  input.evidence.setBranches(preSoftLeafId);
  const finalizationPrompt = reviewFinalizationPrompt(reason);
  try {
    input.recordStablePrefix(preSoftLeafId, finalizationPrompt);
  } catch (error) {
    return failAndFinish(input, asError(error), false, "prefix_evidence_failed");
  }
  input.lifecycle.transition("soft_finalizing", reason);
  input.eventBus.emit(REVIEW_PHASE_EVENT, "soft_finalizing");
  const soft = settlePrompt(input.session.prompt(finalizationPrompt));
  const softOutcome = await raceSoft(soft, input.gate, input.policy.finalizationGraceMs);
  if (softOutcome.kind === "accepted") {
    return await finishAccepted(input, "soft_submission");
  }

  const softReason =
    softOutcome.kind === "timeout"
      ? "soft_deadline"
      : softOutcome.kind === "failed"
        ? "soft_model_error"
        : "soft_missing_submission";
  input.lifecycle.transition("quiescing_before_hard", softReason);
  const preHardQuiescence = await quiesce(input, "pre_hard_quiescence_failed");
  if (preHardQuiescence !== undefined) return preHardQuiescence;
  if (input.gate.hasSubmission()) {
    input.lifecycle.transition("hard_finalizing", "soft_submission_settled_during_quiescence");
    return await finishAccepted(input, "soft_submission");
  }
  void soft.then(
    () => undefined,
    () => undefined,
  );

  const softBranchLeafId = input.sessionManager.getLeafId();
  input.evidence.setBranches(preSoftLeafId, softBranchLeafId ?? undefined);
  input.lifecycle.transition("hard_finalizing", softReason);
  input.eventBus.emit(REVIEW_PHASE_EVENT, "hard_finalizing");
  let hard: ForcedSubmissionResult;
  try {
    hard = await input.hardFinalize(preSoftLeafId, finalizationPrompt);
  } catch (error) {
    return failAndFinish(input, asError(error), false, "hard_finalization_exception");
  }
  if (hard.kind === "accepted") return await finishAccepted(input, "hard_submission");
  return failAndFinish(
    input,
    hard.error,
    hard.forcedExitRequired,
    hard.forcedExitRequired ? "hard_transport_unsettled" : "hard_finalization_failed",
  );
}

async function finishAccepted(
  input: ReviewControllerInput,
  reason: string,
): Promise<ReviewControllerResult> {
  try {
    await waitForReviewIdle(input.session);
  } catch (error) {
    if (input.lifecycle.tryAccept(reason)) input.evidence.recordAcceptedSubmission();
    input.lifecycle.transition("shutdown_ready", "accepted_idle_confirmation_failed");
    input.evidence.markComplete(false);
    return { forcedExitRequired: false, error: asError(error) };
  }
  if (input.lifecycle.tryAccept(reason)) input.evidence.recordAcceptedSubmission();
  input.lifecycle.transition("shutdown_ready", "accepted_complete");
  input.lifecycle.record({ kind: "worker_shutdown_ready" });
  input.evidence.markComplete(false);
  return { forcedExitRequired: false };
}

async function quiesce(
  input: ReviewControllerInput,
  reason: string,
): Promise<ReviewControllerResult | undefined> {
  try {
    await quiesceReviewSession(input.session, input.lifecycle);
    return undefined;
  } catch (error) {
    return failAndFinish(input, new Error(reason, { cause: error }), false, reason);
  }
}

function failAndFinish(
  input: ReviewControllerInput,
  error: Error,
  forcedExitRequired: boolean,
  receiptReason: string,
): ReviewControllerResult {
  input.lifecycle.tryFail(receiptReason);
  input.lifecycle.transition(
    "shutdown_ready",
    forcedExitRequired ? "parent_sigterm_required" : "failed_complete",
  );
  input.lifecycle.record({ kind: "worker_shutdown_ready" });
  input.evidence.markComplete(forcedExitRequired);
  return { forcedExitRequired, error };
}

async function raceSoft(
  prompt: Promise<PromptOutcome>,
  gate: ReviewSubmissionGate,
  timeoutMs: number,
): Promise<PromptOutcome | { readonly kind: "accepted" } | { readonly kind: "timeout" }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ readonly kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      prompt,
      gate.accepted.then(() => ({ kind: "accepted" as const })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function settlePrompt(prompt: Promise<void>): Promise<PromptOutcome> {
  return prompt.then(
    () => ({ kind: "settled" }),
    (error: unknown) => ({ kind: "failed", error: asError(error) }),
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
