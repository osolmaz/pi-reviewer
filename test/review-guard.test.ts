import { describe, expect, it } from "vitest";

import { toolUnavailableReason } from "../reviewer/extensions/review-guard.js";

describe("review tool availability", () => {
  it("permits configured review tools during exploration", () => {
    expect(toolUnavailableReason("read", "exploring")).toBeUndefined();
    expect(toolUnavailableReason("submit_review", "exploring")).toBeUndefined();
  });

  it("blocks investigation tools during soft finalization without changing definitions", () => {
    expect(toolUnavailableReason("read", "soft_finalizing")).toBe(
      "Tool read is unavailable during review finalization",
    );
    expect(toolUnavailableReason("review_shell", "soft_finalizing")).toBe(
      "Tool review_shell is unavailable during review finalization",
    );
    expect(toolUnavailableReason("submit_review", "soft_finalizing")).toBeUndefined();
  });

  it("blocks extension execution during direct hard finalization", () => {
    expect(toolUnavailableReason("read", "hard_finalizing")).toContain("finalization");
    expect(toolUnavailableReason("submit_review", "hard_finalizing")).toBeUndefined();
  });

  it("continues to reject tools outside read-only review mode", () => {
    expect(toolUnavailableReason("write", "exploring")).toBe(
      "Tool write is unavailable in read-only review mode",
    );
  });
});
