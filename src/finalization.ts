import type { AgentSession, EventBus } from "@earendil-works/pi-coding-agent";

export const REVIEW_FINALIZATION_EVENT = "pi-reviewer:finalization";

type FinalizationSession = Pick<AgentSession, "setThinkingLevel">;

export function enterReviewFinalization(session: FinalizationSession, eventBus: EventBus): void {
  session.setThinkingLevel("off");
  eventBus.emit(REVIEW_FINALIZATION_EVENT, undefined);
}
