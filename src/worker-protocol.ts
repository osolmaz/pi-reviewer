import type { ThinkingLevel } from "./types.js";

export type ReviewWorkerRequest = {
  readonly version: 1;
  readonly cwd: string;
  readonly prompt: string;
  readonly authPath: string;
  readonly modelsPath: string;
  readonly configDir: string;
  readonly extensionPath: string;
  readonly systemPrompt: string;
  readonly provider: string;
  readonly model: string;
  readonly customModel: boolean;
  readonly persistSession: boolean;
  readonly sessionDir: string;
  readonly sessionReceipt: string | null;
  readonly lifecycleReceipt: string | null;
  readonly maxModelRequests: number | null;
  readonly timeBudgetMs: number;
  readonly warningRemainingMs: readonly number[];
  readonly finalizationGraceMs: number;
  readonly hardFinalizationGraceMs: number;
  readonly thinking: ThinkingLevel;
  readonly tools: readonly string[];
};

const MAX_WORKER_INPUT_BYTES = 2 * 1024 * 1024;

export async function readWorkerRequest(
  input: NodeJS.ReadableStream = process.stdin,
): Promise<ReviewWorkerRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_WORKER_INPUT_BYTES) throw new Error("review worker input exceeded size limit");
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new Error("review worker received invalid JSON", { cause: error });
  }
  return validateWorkerRequest(value);
}

export function validateWorkerRequest(value: unknown): ReviewWorkerRequest {
  if (!isRecord(value) || value["version"] !== 1) {
    throw new Error("review worker request must use version 1");
  }
  const allowed = new Set([
    "version",
    "cwd",
    "prompt",
    "authPath",
    "modelsPath",
    "configDir",
    "extensionPath",
    "systemPrompt",
    "provider",
    "model",
    "customModel",
    "persistSession",
    "sessionDir",
    "sessionReceipt",
    "lifecycleReceipt",
    "maxModelRequests",
    "timeBudgetMs",
    "warningRemainingMs",
    "finalizationGraceMs",
    "hardFinalizationGraceMs",
    "thinking",
    "tools",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0)
    throw new Error(`review worker request has unknown field ${unknown.join(", ")}`);
  const tools = value["tools"];
  if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string" && tool !== "")) {
    throw new Error("review worker tools must be nonempty strings");
  }
  const timeBudgetMs = positiveMilliseconds(value["timeBudgetMs"], "timeBudgetMs");
  const warningRemainingMs = warningTimes(value["warningRemainingMs"], timeBudgetMs);
  return {
    version: 1,
    cwd: requiredString(value, "cwd"),
    prompt: requiredString(value, "prompt"),
    authPath: requiredString(value, "authPath"),
    modelsPath: requiredString(value, "modelsPath"),
    configDir: requiredString(value, "configDir"),
    extensionPath: requiredString(value, "extensionPath"),
    systemPrompt: requiredString(value, "systemPrompt"),
    provider: requiredString(value, "provider"),
    model: requiredString(value, "model"),
    customModel: requiredBoolean(value, "customModel"),
    persistSession: requiredBoolean(value, "persistSession"),
    sessionDir: requiredString(value, "sessionDir"),
    sessionReceipt: optionalString(value["sessionReceipt"], "sessionReceipt"),
    lifecycleReceipt: optionalString(value["lifecycleReceipt"], "lifecycleReceipt"),
    maxModelRequests: optionalRequestLimit(value["maxModelRequests"]),
    timeBudgetMs,
    warningRemainingMs,
    finalizationGraceMs: positiveMilliseconds(value["finalizationGraceMs"], "finalizationGraceMs"),
    hardFinalizationGraceMs: positiveMilliseconds(
      value["hardFinalizationGraceMs"],
      "hardFinalizationGraceMs",
    ),
    thinking: thinkingLevel(value["thinking"]),
    tools,
  };
}

function requiredString(value: Readonly<Record<string, unknown>>, key: string): string {
  const entry = value[key];
  if (typeof entry !== "string" || entry === "")
    throw new Error(`review worker ${key} is required`);
  return entry;
}

function requiredBoolean(value: Readonly<Record<string, unknown>>, key: string): boolean {
  const entry = value[key];
  if (typeof entry !== "boolean") throw new Error(`review worker ${key} is required`);
  return entry;
}

function optionalString(value: unknown, key: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value === "") {
    throw new Error(`review worker ${key} must be a nonempty string or null`);
  }
  return value;
}

function positiveMilliseconds(value: unknown, key: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1_000 ||
    value > 86_400_000
  ) {
    throw new Error(`review worker ${key} must be between 1000 and 86400000`);
  }
  return value;
}

function warningTimes(value: unknown, timeBudgetMs: number): readonly number[] {
  if (!Array.isArray(value)) throw new Error("review worker warningRemainingMs must be an array");
  const warnings = value.map((entry) => positiveIntegerMilliseconds(entry));
  if (warnings.some((entry) => entry >= timeBudgetMs)) {
    throw new Error("review worker warnings must be less than timeBudgetMs");
  }
  if (new Set(warnings).size !== warnings.length) {
    throw new Error("review worker warnings must be unique");
  }
  for (let index = 1; index < warnings.length; index += 1) {
    if ((warnings[index - 1] ?? 0) <= (warnings[index] ?? 0)) {
      throw new Error("review worker warnings must be in descending order");
    }
  }
  return warnings;
}

function positiveIntegerMilliseconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("review worker warningRemainingMs entries must be positive integers");
  }
  return value;
}

function optionalRequestLimit(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error("review worker maxModelRequests must be between 1 and 100");
  }
  return value;
}

function thinkingLevel(value: unknown): ThinkingLevel {
  switch (value) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      throw new Error("review worker thinking level is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
