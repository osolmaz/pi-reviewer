import {
  OUTPUT_FORMATS,
  THINKING_LEVELS,
  type OutputFormat,
  type ReviewRequest,
  type ReviewTarget,
  type ThinkingLevel,
  type TimeWarning,
} from "./types.js";

const MAX_INPUT_CHARS = 16_384;

export type ParsedCommand =
  | { readonly kind: "review"; readonly request: ReviewRequest }
  | { readonly kind: "config-show" }
  | { readonly kind: "config-reset" }
  | { readonly kind: "config-set-model"; readonly model: string }
  | { readonly kind: "config-set-thinking"; readonly thinking: ThinkingLevel }
  | { readonly kind: "login"; readonly provider?: string }
  | { readonly kind: "models"; readonly search?: string }
  | { readonly kind: "help" }
  | { readonly kind: "version" };

type ReviewFields = {
  cwd: string;
  model?: string;
  modelManifest?: string;
  metricsFile?: string;
  sessionDir?: string;
  sessionReceipt?: string;
  lifecycleReceipt?: string;
  persistSession?: boolean;
  maxModelRequests?: number;
  timeBudgetMs?: number;
  timeWarnings: TimeWarning[];
  finalizationGraceMs?: number;
  hardFinalizationGraceMs?: number;
  thinking?: ThinkingLevel;
  format?: OutputFormat;
  title?: string;
  target?: ReviewTarget;
  custom: string[];
};

export function parseArgs(args: readonly string[], cwd = process.cwd()): ParsedCommand {
  const [command, ...rest] = args;
  if (["--help", "-h", "help"].includes(command ?? "")) return { kind: "help" };
  if (["--version", "-v"].includes(command ?? "")) return { kind: "version" };
  const special = parseSpecialCommand(command, rest);
  return special ?? { kind: "review", request: parseReview(args, cwd) };
}

function parseSpecialCommand(
  command: string | undefined,
  args: readonly string[],
): ParsedCommand | undefined {
  if (command === "config") return parseConfig(args);
  if (command === "login") return parseLogin(args);
  if (command === "models") return parseModels(args);
  return undefined;
}

function parseConfig(args: readonly string[]): ParsedCommand {
  const [action, ...rest] = args;
  if (action === "show") return noConfigArguments(rest, { kind: "config-show" });
  if (action === "reset") return noConfigArguments(rest, { kind: "config-reset" });
  if (action === "set") return parseConfigSet(rest);
  throw new Error("usage: pi-reviewer config <show|reset|set model VALUE|set thinking LEVEL>");
}

function parseConfigSet(args: readonly string[]): ParsedCommand {
  const [key, value, extra] = args;
  if (value === undefined || extra !== undefined) {
    throw new Error("usage: pi-reviewer config set <model VALUE|thinking LEVEL>");
  }
  if (key === "model") return { kind: "config-set-model", model: validateModel(value) };
  if (key === "thinking") return { kind: "config-set-thinking", thinking: validateThinking(value) };
  throw new Error("config key must be model or thinking");
}

function noConfigArguments<T extends ParsedCommand>(args: readonly string[], command: T): T {
  if (args.length > 0) throw new Error("config command received unexpected arguments");
  return command;
}

function parseLogin(args: readonly string[]): ParsedCommand {
  if (args.length > 1) throw new Error("usage: pi-reviewer login [provider]");
  const provider = args[0];
  return provider === undefined ? { kind: "login" } : { kind: "login", provider };
}

function parseModels(args: readonly string[]): ParsedCommand {
  if (args.length > 1) throw new Error("usage: pi-reviewer models [search]");
  const search = args[0];
  return search === undefined ? { kind: "models" } : { kind: "models", search };
}

function parseReview(args: readonly string[], cwd: string): ReviewRequest {
  const fields: ReviewFields = { cwd, custom: [], timeWarnings: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = required(args[index], "missing argument");
    index += consumeReviewArg(fields, arg, args[index + 1]);
  }
  return finalizeReviewFields(fields);
}

function finalizeReviewFields(fields: ReviewFields): ReviewRequest {
  const custom = fields.custom.join(" ").trim();
  if (custom.length > MAX_INPUT_CHARS) throw new Error("custom review instructions are too long");
  if (custom !== "") setTarget(fields, { kind: "custom", instructions: custom });
  if (fields.target === undefined) throw new Error(reviewUsage());
  assertTitleTarget(fields);
  assertSessionOptions(fields);
  return {
    target: withCommitTitle(fields.target, fields.title),
    cwd: fields.cwd,
    ...reviewOptions(fields),
  };
}

function reviewOptions(fields: ReviewFields): Omit<ReviewRequest, "target" | "cwd"> {
  return {
    ...modelOptions(fields),
    ...sessionOptions(fields),
    ...budgetOptions(fields),
    ...presentationOptions(fields),
  };
}

function modelOptions(fields: ReviewFields): Omit<ReviewRequest, "target" | "cwd"> {
  return {
    ...(fields.model === undefined ? {} : { model: fields.model }),
    ...(fields.modelManifest === undefined ? {} : { modelManifest: fields.modelManifest }),
    ...(fields.metricsFile === undefined ? {} : { metricsFile: fields.metricsFile }),
    ...(fields.maxModelRequests === undefined ? {} : { maxModelRequests: fields.maxModelRequests }),
  };
}

function sessionOptions(fields: ReviewFields): Omit<ReviewRequest, "target" | "cwd"> {
  return {
    ...(fields.sessionDir === undefined ? {} : { sessionDir: fields.sessionDir }),
    ...(fields.sessionReceipt === undefined ? {} : { sessionReceipt: fields.sessionReceipt }),
    ...(fields.lifecycleReceipt === undefined ? {} : { lifecycleReceipt: fields.lifecycleReceipt }),
    ...(fields.persistSession === undefined ? {} : { persistSession: fields.persistSession }),
  };
}

function budgetOptions(fields: ReviewFields): Omit<ReviewRequest, "target" | "cwd"> {
  return {
    ...(fields.timeBudgetMs === undefined ? {} : { timeBudgetMs: fields.timeBudgetMs }),
    ...(fields.timeWarnings.length === 0 ? {} : { timeWarnings: fields.timeWarnings }),
    ...(fields.finalizationGraceMs === undefined
      ? {}
      : { finalizationGraceMs: fields.finalizationGraceMs }),
    ...(fields.hardFinalizationGraceMs === undefined
      ? {}
      : { hardFinalizationGraceMs: fields.hardFinalizationGraceMs }),
  };
}

function presentationOptions(fields: ReviewFields): Omit<ReviewRequest, "target" | "cwd"> {
  return {
    ...(fields.thinking === undefined ? {} : { thinking: fields.thinking }),
    ...(fields.format === undefined ? {} : { format: fields.format }),
  };
}

function assertTitleTarget(fields: ReviewFields): void {
  if (fields.title !== undefined && fields.target?.kind !== "commit") {
    throw new Error("--title requires --commit");
  }
}

function assertSessionOptions(fields: ReviewFields): void {
  if (fields.persistSession !== false) return;
  if (
    fields.sessionDir !== undefined ||
    fields.sessionReceipt !== undefined ||
    fields.lifecycleReceipt !== undefined
  ) {
    throw new Error("--no-session cannot be combined with session output options");
  }
}

function consumeReviewArg(fields: ReviewFields, arg: string, next: string | undefined): number {
  const target = consumeTargetArg(fields, arg, next);
  if (target !== undefined) return target;
  if (arg === "--no-session") {
    fields.persistSession = false;
    return 0;
  }
  const option = consumeReviewOption(fields, arg, next);
  if (option !== undefined) return option;
  if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
  fields.custom.push(arg);
  return 0;
}

function consumeTargetArg(
  fields: ReviewFields,
  arg: string,
  next: string | undefined,
): number | undefined {
  if (arg === "--uncommitted") {
    setTarget(fields, { kind: "uncommitted" });
    return 0;
  }
  if (arg === "--base") {
    setTarget(fields, { kind: "base", branch: requiredValue(next, arg) });
    return 1;
  }
  if (arg === "--commit") {
    setTarget(fields, { kind: "commit", sha: requiredValue(next, arg) });
    return 1;
  }
  return undefined;
}

function consumeReviewOption(
  fields: ReviewFields,
  arg: string,
  next: string | undefined,
): number | undefined {
  if (consumeExecutionOption(fields, arg, next)) return 1;
  if (arg === "--title") fields.title = requiredValue(next, arg);
  else if (arg === "--model") fields.model = validateModel(requiredValue(next, arg));
  else if (arg === "--thinking") fields.thinking = validateThinking(requiredValue(next, arg));
  else if (arg === "--format") fields.format = validateOutputFormat(requiredValue(next, arg));
  else if (arg === "--cwd") fields.cwd = requiredValue(next, arg);
  else return undefined;
  return 1;
}

function consumeExecutionOption(
  fields: ReviewFields,
  arg: string,
  next: string | undefined,
): boolean {
  if (consumeBudgetOption(fields, arg, next)) return true;
  if (arg === "--model-manifest") fields.modelManifest = requiredValue(next, arg);
  else if (arg === "--metrics-file") fields.metricsFile = requiredValue(next, arg);
  else if (arg === "--session-dir") fields.sessionDir = requiredValue(next, arg);
  else if (arg === "--session-receipt") fields.sessionReceipt = requiredValue(next, arg);
  else if (arg === "--lifecycle-receipt") fields.lifecycleReceipt = requiredValue(next, arg);
  else if (arg === "--max-model-requests") {
    fields.maxModelRequests = validateMaxModelRequests(requiredValue(next, arg));
  } else return false;
  return true;
}

function consumeBudgetOption(fields: ReviewFields, arg: string, next: string | undefined): boolean {
  if (arg === "--time-budget") {
    fields.timeBudgetMs = validateDuration(requiredValue(next, arg), "time budget");
  } else if (arg === "--time-warning") {
    fields.timeWarnings.push(validateTimeWarning(requiredValue(next, arg)));
  } else if (arg === "--finalization-grace") {
    fields.finalizationGraceMs = validateDuration(requiredValue(next, arg), "finalization grace");
  } else if (arg === "--hard-finalization-grace") {
    fields.hardFinalizationGraceMs = validateDuration(
      requiredValue(next, arg),
      "hard finalization grace",
    );
  } else return false;
  return true;
}

function setTarget(fields: ReviewFields, target: ReviewTarget): void {
  if (fields.target !== undefined) throw new Error("review targets are mutually exclusive");
  fields.target = target;
}

function withCommitTitle(target: ReviewTarget, title: string | undefined): ReviewTarget {
  if (target.kind !== "commit" || title === undefined) return target;
  return { ...target, title };
}

export function parseModel(value: string): { provider: string; model: string } {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("model must use provider/model format");
  }
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

export function validateModel(value: string): string {
  const trimmed = value.trim();
  if (trimmed !== value || trimmed.length > 512) throw new Error("invalid model value");
  parseModel(trimmed);
  return trimmed;
}

export function validateMaxModelRequests(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error("max model requests must be an integer");
  const requests = Number(value);
  if (requests > 100) throw new Error("max model requests must be at most 100");
  return requests;
}

export function validateDuration(value: string, label = "duration"): number {
  const match = /^([1-9][0-9]*)(ms|s|m|h)$/u.exec(value);
  if (match === null) throw new Error(`${label} must use a positive ms, s, m, or h duration`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "";
  const multipliers: Readonly<Record<string, number>> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
  };
  const milliseconds = amount * (multipliers[unit] ?? Number.NaN);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1_000 || milliseconds > 86_400_000) {
    throw new Error(`${label} must be between 1s and 24h`);
  }
  return milliseconds;
}

export function validateTimeWarning(value: string): TimeWarning {
  if (value.endsWith("%")) {
    const percentage = /^([1-9][0-9]?)%$/u.exec(value);
    if (percentage === null) {
      throw new Error("time warning percentage must be between 1% and 99%");
    }
    return { kind: "percentage", percentage: Number(percentage[1]) };
  }
  return { kind: "duration", milliseconds: validateDuration(value, "time warning") };
}

export function validateThinking(value: string): ThinkingLevel {
  if (THINKING_LEVELS.some((level) => level === value)) return value as ThinkingLevel;
  throw new Error(`thinking must be one of ${THINKING_LEVELS.join(", ")}`);
}

export function validateOutputFormat(value: string): OutputFormat {
  if (OUTPUT_FORMATS.some((format) => format === value)) return value as OutputFormat;
  throw new Error(`format must be one of ${OUTPUT_FORMATS.join(", ")}`);
}

function requiredValue(value: string | undefined, option: string): string {
  return required(value, `${option} requires a value`);
}

function required(value: string | undefined, message: string): string {
  if (value === undefined || value === "") throw new Error(message);
  return value;
}

export function reviewUsage(): string {
  return "usage: pi-reviewer (--uncommitted | --base BRANCH | --commit SHA | INSTRUCTIONS) [--model PROVIDER/MODEL] [--model-manifest PATH] [--metrics-file PATH] [--session-dir DIR] [--session-receipt PATH] [--lifecycle-receipt PATH] [--no-session] [--max-model-requests N] [--time-budget DURATION] [--time-warning PERCENT|DURATION] [--finalization-grace DURATION] [--hard-finalization-grace DURATION] [--thinking LEVEL] [--format text|json] [--cwd DIR]";
}
