import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { requireSingleSubmissionCall } from "../src/forced-submission-turn.js";
import {
  createSubmitReviewTool,
  prepareReviewSubmission,
  ReviewSubmissionGate,
} from "../src/submit-review.js";
import { MAX_FINDING_TITLE_CHARACTERS } from "../src/types.js";

const VALID = {
  findings: [
    {
      title: "[P1] Keep the first result",
      body: "The second path overwrites it.",
      confidence_score: 0.9,
      priority: 1,
      code_location: {
        absolute_file_path: "src/run.ts",
        line_range: { start: 10, end: 11 },
      },
    },
  ],
  overall_correctness: "patch is incorrect",
  overall_explanation: "One defect remains.",
  overall_confidence_score: 0.9,
} as const;

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
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
  };
}

describe("ReviewSubmissionGate", () => {
  it("normalizes one valid review and resolves repository paths", async () => {
    const gate = new ReviewSubmissionGate("/repo");
    const accepted = gate.accept(VALID);
    expect(accepted.findings[0]?.code_location.absolute_file_path).toBe("/repo/src/run.ts");
    await expect(gate.accepted).resolves.toEqual(accepted);
    expect(gate.acceptedCallCount).toBe(1);
  });

  it("accepts through the normal registered Pi tool entry point", async () => {
    const gate = new ReviewSubmissionGate("/repo");
    const tool = createSubmitReviewTool(gate);
    const result = await tool.execute("call-1", VALID, undefined, undefined, {} as never);
    expect(result).toMatchObject({
      content: [{ type: "text", text: "Final review submitted." }],
      terminate: true,
    });
    expect(gate.acceptedCallCount).toBe(1);
  });

  it("shortens long titles without mutating raw arguments", () => {
    const originalTitle = `[P1] ${"x".repeat(122)}`;
    const raw = {
      ...VALID,
      findings: [{ ...VALID.findings[0], title: originalTitle }],
    };
    const prepared = prepareReviewSubmission(raw);
    const accepted = new ReviewSubmissionGate("/repo").accept(raw);
    const title = accepted.findings[0]?.title ?? "";
    expect(prepared.normalization).toEqual({
      titleTruncationCount: 1,
      priorityInferenceCount: 0,
    });
    expect(Array.from(title)).toHaveLength(MAX_FINDING_TITLE_CHARACTERS);
    expect(title.endsWith("…")).toBe(true);
    expect(raw.findings[0]?.title).toBe(originalTitle);
  });

  it("uses Unicode characters instead of UTF-16 code units for the title limit", () => {
    const title = `[P1] ${"x".repeat(74)}😀`;
    expect(Array.from(title)).toHaveLength(MAX_FINDING_TITLE_CHARACTERS);
    expect(title.length).toBe(MAX_FINDING_TITLE_CHARACTERS + 1);
    expect(
      new ReviewSubmissionGate("/repo").accept({
        ...VALID,
        findings: [{ ...VALID.findings[0], title }],
      }).findings[0]?.title,
    ).toBe(title);
  });

  it("infers an omitted priority only from an exact title prefix", () => {
    const gate = new ReviewSubmissionGate("/repo");
    const accepted = gate.accept({
      ...VALID,
      findings: [{ ...VALID.findings[0], priority: null }],
    });
    expect(accepted.findings[0]?.priority).toBe(1);
    expect(() =>
      new ReviewSubmissionGate("/repo").accept({
        ...VALID,
        findings: [{ ...VALID.findings[0], title: "No priority", priority: null }],
      }),
    ).toThrow("priority");
  });

  it("matches AgentSession value conversion in the direct gate", () => {
    const accepted = new ReviewSubmissionGate("/repo").accept({
      ...VALID,
      findings: [
        {
          ...VALID.findings[0],
          priority: "1",
          confidence_score: "0.9",
          code_location: {
            ...VALID.findings[0].code_location,
            line_range: { start: "10", end: "11" },
          },
        },
      ],
      overall_confidence_score: "0.9",
    });
    expect(accepted.findings[0]).toMatchObject({
      priority: 1,
      confidence_score: 0.9,
      code_location: { line_range: { start: 10, end: 11 } },
    });
  });

  it("accepts a valid empty review", () => {
    const gate = new ReviewSubmissionGate("/repo");
    expect(
      gate.accept({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "No actionable defect found.",
        overall_confidence_score: 0.8,
      }).findings,
    ).toEqual([]);
  });

  it("rejects malformed, escaping, and duplicate submissions", () => {
    const malformed = new ReviewSubmissionGate("/repo");
    expect(() => malformed.accept({ findings: [] })).toThrow("overall_correctness");
    const escaping = new ReviewSubmissionGate("/repo");
    expect(() =>
      escaping.accept({
        ...VALID,
        findings: [
          {
            ...VALID.findings[0],
            code_location: {
              absolute_file_path: "../secret",
              line_range: { start: 1, end: 1 },
            },
          },
        ],
      }),
    ).toThrow("inside the review checkout");
    const extra = new ReviewSubmissionGate("/repo");
    expect(() => extra.accept({ ...VALID, extra: true })).toThrow("additional properties");
    const conflicting = new ReviewSubmissionGate("/repo");
    expect(() =>
      conflicting.accept({
        ...VALID,
        findings: [{ ...VALID.findings[0], title: "[P2] Conflict" }],
      }),
    ).toThrow("title priority must match priority");
    const duplicate = new ReviewSubmissionGate("/repo");
    duplicate.accept(VALID);
    expect(() => duplicate.accept(VALID)).toThrow("only once");
  });
});

describe("hard response cardinality", () => {
  const call = { type: "toolCall" as const, id: "call-1", name: "submit_review", arguments: VALID };

  it("accepts exactly one submit_review call and no prose", () => {
    expect(requireSingleSubmissionCall(assistant([call]))).toEqual(call);
    expect(requireSingleSubmissionCall(assistant([{ type: "text", text: "  " }, call]))).toEqual(
      call,
    );
  });

  it("rejects missing, multiple, other-tool, prose-only, and mixed prose responses", () => {
    expect(() => requireSingleSubmissionCall(assistant([]))).toThrow("exactly one");
    expect(() => requireSingleSubmissionCall(assistant([call, { ...call, id: "call-2" }]))).toThrow(
      "exactly one",
    );
    expect(() => requireSingleSubmissionCall(assistant([{ ...call, name: "read" }]))).toThrow(
      "disallowed tool",
    );
    expect(() =>
      requireSingleSubmissionCall(assistant([{ type: "text", text: "review prose" }])),
    ).toThrow("exactly one");
    expect(() =>
      requireSingleSubmissionCall(assistant([{ type: "text", text: "review prose" }, call])),
    ).toThrow("content outside");
  });
});
