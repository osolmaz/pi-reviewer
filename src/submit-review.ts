import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";

import { parseReviewOutput } from "./review-output.js";

const lineRange = Type.Object(
  {
    start: Type.Integer({ minimum: 1 }),
    end: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const finding = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 80 }),
    body: Type.String({ minLength: 1 }),
    confidence_score: Type.Number({ minimum: 0, maximum: 1 }),
    priority: Type.Integer({ minimum: 0, maximum: 3 }),
    code_location: Type.Object(
      {
        absolute_file_path: Type.String({ minLength: 1 }),
        line_range: lineRange,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const reviewSubmissionSchema: TSchema = Type.Object(
  {
    findings: Type.Array(finding),
    overall_correctness: StringEnum(["patch is correct", "patch is incorrect"] as const),
    overall_explanation: Type.String({ minLength: 1 }),
    overall_confidence_score: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);

export type ReviewSubmission = {
  readonly findings: {
    readonly title: string;
    readonly body: string;
    readonly confidence_score: number;
    readonly priority: number;
    readonly code_location: {
      readonly absolute_file_path: string;
      readonly line_range: { readonly start: number; readonly end: number };
    };
  }[];
  readonly overall_correctness: "patch is correct" | "patch is incorrect";
  readonly overall_explanation: string;
  readonly overall_confidence_score: number;
};

export class ReviewSubmissionGate {
  private acceptedValue: ReviewSubmission | undefined;
  private resolveAcceptance: (submission: ReviewSubmission) => void = () => undefined;
  readonly accepted: Promise<ReviewSubmission>;

  constructor(
    private readonly cwd: string,
    private readonly onAccepted?: (submission: ReviewSubmission) => void,
  ) {
    this.accepted = new Promise<ReviewSubmission>((resolve) => {
      this.resolveAcceptance = resolve;
    });
  }

  get submission(): ReviewSubmission | undefined {
    return this.acceptedValue;
  }

  get acceptedCallCount(): number {
    return this.acceptedValue === undefined ? 0 : 1;
  }

  accept(value: unknown): ReviewSubmission {
    if (this.acceptedValue !== undefined) throw new Error("submit_review may be called only once");
    const parsed = parseReviewOutput(JSON.stringify(value), this.cwd);
    const normalized: ReviewSubmission = {
      findings: parsed.findings.map((entry) => ({
        title: entry.title,
        body: entry.body,
        confidence_score: entry.confidenceScore,
        priority: entry.priority,
        code_location: {
          absolute_file_path: entry.codeLocation.absoluteFilePath,
          line_range: {
            start: entry.codeLocation.lineRange.start,
            end: entry.codeLocation.lineRange.end,
          },
        },
      })),
      overall_correctness: parsed.overallCorrectness,
      overall_explanation: parsed.overallExplanation,
      overall_confidence_score: parsed.overallConfidenceScore,
    };
    this.acceptedValue = normalized;
    this.onAccepted?.(normalized);
    this.resolveAcceptance(normalized);
    return normalized;
  }
}

export function createSubmitReviewTool(gate: ReviewSubmissionGate): ToolDefinition {
  return defineTool({
    name: "submit_review",
    label: "Submit review",
    description:
      "Submit the final code review in the required machine-readable schema and end the review. Use this exactly once as the final action.",
    promptSnippet: "Submit the final validated review and end the review",
    promptGuidelines: [
      "Use submit_review exactly once as the final action after gathering enough evidence.",
      "Call submit_review instead of returning the final review as prose or a JSON text block.",
    ],
    parameters: reviewSubmissionSchema,
    execute(_toolCallId, params) {
      const submission = gate.accept(params);
      return Promise.resolve({
        content: [{ type: "text" as const, text: "Final review submitted." }],
        details: submission,
        terminate: true,
      });
    },
  });
}
