import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  listenForReviewFinalization,
  REVIEW_FINALIZATION_EVENT as GUARD_FINALIZATION_EVENT,
} from "../reviewer/extensions/review-guard.js";
import { enterReviewFinalization, REVIEW_FINALIZATION_EVENT } from "../src/finalization.js";

describe("review finalization", () => {
  it("uses the review guard event channel", () => {
    expect(REVIEW_FINALIZATION_EVENT).toBe(GUARD_FINALIZATION_EVENT);
  });

  it("activates and disposes the review guard listener", () => {
    const eventBus = createEventBus();
    const state = listenForReviewFinalization(eventBus);

    expect(state.isActive()).toBe(false);
    eventBus.emit(REVIEW_FINALIZATION_EVENT, undefined);
    expect(state.isActive()).toBe(true);
    state.dispose();
  });

  it("disables reasoning and notifies the review guard", () => {
    const transitions: string[] = [];
    const setThinkingLevel = vi.fn(() => {
      transitions.push("thinking-off");
    });
    const emit = vi.fn(() => {
      transitions.push("notify-guard");
    });

    enterReviewFinalization({ setThinkingLevel }, { emit, on: vi.fn() } satisfies EventBus);

    expect(setThinkingLevel).toHaveBeenCalledOnce();
    expect(setThinkingLevel).toHaveBeenCalledWith("off");
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(REVIEW_FINALIZATION_EVENT, undefined);
    expect(transitions).toEqual(["thinking-off", "notify-guard"]);
  });
});
