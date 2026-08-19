import { describe, expect, it } from "vitest";

import { toolUnavailableReason } from "../reviewer/extensions/review-guard.js";

describe("review tool availability", () => {
  it("permits configured review tools during exploration", () => {
    expect(toolUnavailableReason("read", false)).toBeUndefined();
    expect(toolUnavailableReason("submit_review", false)).toBeUndefined();
  });

  it("blocks investigation tools without changing the active tool set", () => {
    expect(toolUnavailableReason("read", true)).toBe(
      "Tool read is unavailable during review finalization",
    );
    expect(toolUnavailableReason("review_shell", true)).toBe(
      "Tool review_shell is unavailable during review finalization",
    );
    expect(toolUnavailableReason("submit_review", true)).toBeUndefined();
  });

  it("continues to reject tools outside read-only review mode", () => {
    expect(toolUnavailableReason("write", false)).toBe(
      "Tool write is unavailable in read-only review mode",
    );
  });
});
