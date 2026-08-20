export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const OUTPUT_FORMATS = ["text", "json"] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export type TimeWarning =
  | { readonly kind: "percentage"; readonly percentage: number }
  | { readonly kind: "duration"; readonly milliseconds: number };

export type ModelSelection = {
  readonly provider: string;
  readonly model: string;
  readonly thinking: ThinkingLevel;
};

export type CustomModelManifest = {
  readonly version: 1;
  readonly provider: {
    readonly id: string;
    readonly baseUrl: string;
    readonly apiKeyEnv?: string;
    readonly compat?: {
      readonly supportsDeveloperRole?: boolean;
      readonly supportsReasoningEffort?: boolean;
    };
  };
  readonly model: {
    readonly id: string;
    readonly name?: string;
    readonly reasoning?: boolean;
    readonly thinkingFormat?: "deepseek" | "qwen-chat-template";
    readonly input?: readonly string[];
    readonly contextWindow?: number;
    readonly maxTokens?: number;
    readonly cost?: {
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
    };
  };
};

export type ReviewTarget =
  | { readonly kind: "uncommitted" }
  | { readonly kind: "base"; readonly branch: string }
  | { readonly kind: "commit"; readonly sha: string; readonly title?: string }
  | { readonly kind: "custom"; readonly instructions: string };

export type ReviewRequest = {
  readonly target: ReviewTarget;
  readonly cwd: string;
  readonly model?: string;
  readonly modelManifest?: string;
  readonly metricsFile?: string;
  readonly sessionDir?: string;
  readonly sessionReceipt?: string;
  readonly lifecycleReceipt?: string;
  readonly persistSession?: boolean;
  readonly maxModelRequests?: number;
  readonly timeBudgetMs?: number;
  readonly timeWarnings?: readonly TimeWarning[];
  readonly finalizationGraceMs?: number;
  readonly hardFinalizationGraceMs?: number;
  readonly thinking?: ThinkingLevel;
  readonly format?: OutputFormat;
};

export type ReviewFinding = {
  readonly title: string;
  readonly body: string;
  readonly confidenceScore: number;
  readonly priority: 0 | 1 | 2 | 3;
  readonly codeLocation: {
    readonly absoluteFilePath: string;
    readonly lineRange: {
      readonly start: number;
      readonly end: number;
    };
  };
};

export type ReviewOutput = {
  readonly findings: readonly ReviewFinding[];
  readonly overallCorrectness: "patch is correct" | "patch is incorrect";
  readonly overallExplanation: string;
  readonly overallConfidenceScore: number;
};

export type UserConfig = {
  readonly version: 1;
  readonly auth: "pi";
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
};
