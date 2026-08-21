import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { formatDuration } from "./review-budget.js";

export const REVIEW_QUIESCENCE_ALLOWANCE_MS = 60_000;
export const HARD_CANCELLATION_ALLOWANCE_MS = 30_000;

export const REVIEW_PHASE_EVENT = "pi-reviewer:phase";

export type ReviewPhase =
  | "exploring"
  | "quiescing_before_soft"
  | "soft_finalizing"
  | "quiescing_before_hard"
  | "hard_finalizing"
  | "accepted"
  | "failed"
  | "shutdown_ready";

export type FinalizationReason =
  | "time_budget"
  | "model_request_limit"
  | "missing_submission"
  | "model_error";

export type LifecycleTransition = {
  readonly from: ReviewPhase | null;
  readonly to: ReviewPhase;
  readonly reason: string;
  readonly timestamp: string;
};

export type LifecycleOperationalEvent = {
  readonly kind:
    | "queue_cleared"
    | "abort_requested"
    | "abort_settled"
    | "idle_confirmed"
    | "session_flushed"
    | "receipt_flushed"
    | "worker_shutdown_ready";
  readonly phase: ReviewPhase;
  readonly timestamp: string;
  readonly steeringCount?: number;
  readonly followUpCount?: number;
};

type Clock = () => Date;

const LEGAL_TRANSITIONS: Readonly<Record<ReviewPhase, readonly ReviewPhase[]>> = {
  exploring: ["accepted", "quiescing_before_soft"],
  quiescing_before_soft: ["soft_finalizing", "failed"],
  soft_finalizing: ["accepted", "quiescing_before_hard"],
  quiescing_before_hard: ["hard_finalizing", "failed"],
  hard_finalizing: ["accepted", "failed"],
  accepted: ["shutdown_ready"],
  failed: ["shutdown_ready"],
  shutdown_ready: [],
};

export class ReviewLifecycle {
  private phase: ReviewPhase = "exploring";
  private readonly transitionLog: LifecycleTransition[];
  private readonly operationalLog: LifecycleOperationalEvent[] = [];

  constructor(private readonly clock: Clock = () => new Date()) {
    this.transitionLog = [
      {
        from: null,
        to: "exploring",
        reason: "review_started",
        timestamp: this.timestamp(),
      },
    ];
  }

  get state(): ReviewPhase {
    return this.phase;
  }

  get transitions(): readonly LifecycleTransition[] {
    return [...this.transitionLog];
  }

  get events(): readonly LifecycleOperationalEvent[] {
    return [...this.operationalLog];
  }

  transition(to: ReviewPhase, reason: string): void {
    if (!LEGAL_TRANSITIONS[this.phase].includes(to)) {
      throw new Error(`illegal review lifecycle transition ${this.phase} -> ${to}`);
    }
    const from = this.phase;
    this.phase = to;
    this.transitionLog.push({ from, to, reason, timestamp: this.timestamp() });
  }

  tryAccept(reason: string): boolean {
    if (this.phase === "accepted" || this.phase === "failed" || this.phase === "shutdown_ready") {
      return false;
    }
    if (!LEGAL_TRANSITIONS[this.phase].includes("accepted")) return false;
    this.transition("accepted", reason);
    return true;
  }

  tryFail(reason: string): boolean {
    if (this.phase === "accepted" || this.phase === "failed" || this.phase === "shutdown_ready") {
      return false;
    }
    if (!LEGAL_TRANSITIONS[this.phase].includes("failed")) return false;
    this.transition("failed", reason);
    return true;
  }

  record(event: Omit<LifecycleOperationalEvent, "phase" | "timestamp">): void {
    this.operationalLog.push({ ...event, phase: this.phase, timestamp: this.timestamp() });
  }

  private timestamp(): string {
    return this.clock().toISOString();
  }
}

export type QuiescentSession = Pick<
  AgentSession,
  "abort" | "clearQueue" | "isIdle" | "waitForIdle"
>;

export async function quiesceReviewSession(
  session: QuiescentSession,
  lifecycle: ReviewLifecycle,
  allowanceMs = REVIEW_QUIESCENCE_ALLOWANCE_MS,
): Promise<void> {
  const cleared = session.clearQueue();
  lifecycle.record({
    kind: "queue_cleared",
    steeringCount: cleared.steering.length,
    followUpCount: cleared.followUp.length,
  });
  lifecycle.record({ kind: "abort_requested" });

  let acceptingEvents = true;
  const canRecordEvents = () => acceptingEvents;
  const settlement = session.abort().then(async () => {
    if (!canRecordEvents()) return;
    lifecycle.record({ kind: "abort_settled" });
    await session.waitForIdle();
    if (!canRecordEvents()) return;
    if (!session.isIdle) throw new Error("Pi session reported non-idle after waitForIdle");
    lifecycle.record({ kind: "idle_confirmed" });
  });

  try {
    await withDeadline(
      settlement,
      allowanceMs,
      `review session did not become idle within ${formatDuration(allowanceMs)}`,
    );
  } finally {
    acceptingEvents = false;
  }
}

export async function waitForReviewIdle(
  session: Pick<AgentSession, "isIdle" | "waitForIdle">,
  allowanceMs = REVIEW_QUIESCENCE_ALLOWANCE_MS,
): Promise<void> {
  await withDeadline(
    session.waitForIdle(),
    allowanceMs,
    `review session did not become idle within ${formatDuration(allowanceMs)}`,
  );
  if (!session.isIdle) throw new Error("Pi session reported non-idle after waitForIdle");
}

export async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function reviewFinalizationPrompt(reason: FinalizationReason): string {
  const cause =
    reason === "time_budget"
      ? "The investigation time budget has ended."
      : reason === "model_request_limit"
        ? "The model-request budget has ended."
        : reason === "model_error"
          ? "The exploration request ended with a model error."
          : "The review ended without a structured submission.";
  return `${cause} Investigation tools are disabled. Call submit_review with the best review supported by the evidence already gathered. Each title, including its [P#] prefix, must be at most 80 characters. Do not investigate further and do not return prose.`;
}
