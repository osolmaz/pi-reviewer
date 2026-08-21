import path from "node:path";

import { MAX_FINDING_TITLE_CHARACTERS, type ReviewFinding, type ReviewOutput } from "./types.js";

export function parseReviewOutput(text: string, cwd?: string): ReviewOutput {
  const raw = extractSingleObject(text);
  if (!isRecord(raw)) throw new Error("review output must be a JSON object");
  exactKeys(
    raw,
    ["findings", "overall_correctness", "overall_explanation", "overall_confidence_score"],
    "review output",
  );
  if (!Array.isArray(raw["findings"])) throw new Error("findings must be an array");
  const correctness = raw["overall_correctness"];
  if (correctness !== "patch is correct" && correctness !== "patch is incorrect") {
    throw new Error("overall_correctness is invalid");
  }
  return {
    findings: raw["findings"].map((finding, index) => parseFinding(finding, index, cwd)),
    overallCorrectness: correctness,
    overallExplanation: nonemptyString(raw["overall_explanation"], "overall_explanation"),
    overallConfidenceScore: confidence(raw["overall_confidence_score"], "overall_confidence_score"),
  };
}

function parseFinding(value: unknown, index: number, cwd: string | undefined): ReviewFinding {
  const label = `findings[${String(index)}]`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, ["title", "body", "confidence_score", "priority", "code_location"], label);
  const priority = value["priority"];
  if (priority !== 0 && priority !== 1 && priority !== 2 && priority !== 3) {
    throw new Error(`${label}.priority must be 0, 1, 2, or 3`);
  }
  const title = nonemptyString(value["title"], `${label}.title`);
  if (Array.from(title).length > MAX_FINDING_TITLE_CHARACTERS) {
    throw new Error(`${label}.title exceeds ${String(MAX_FINDING_TITLE_CHARACTERS)} characters`);
  }
  assertTitlePriority(title, priority, label);
  return {
    title,
    body: nonemptyString(value["body"], `${label}.body`),
    confidenceScore: confidence(value["confidence_score"], `${label}.confidence_score`),
    priority,
    codeLocation: parseLocation(value["code_location"], `${label}.code_location`, cwd),
  };
}

function assertTitlePriority(title: string, priority: number, label: string): void {
  const titlePriority = /^\[P([0-3])\]\s/u.exec(title);
  if (titlePriority !== null && Number(titlePriority[1]) !== priority) {
    throw new Error(`${label}.title priority must match priority`);
  }
}

function parseLocation(
  value: unknown,
  label: string,
  cwd: string | undefined,
): ReviewFinding["codeLocation"] {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, ["absolute_file_path", "line_range"], label);
  const absoluteFilePath = nonemptyString(
    value["absolute_file_path"],
    `${label}.absolute_file_path`,
  );
  const resolvedFilePath = resolveFilePath(absoluteFilePath, cwd, label);
  const range = value["line_range"];
  if (!isRecord(range)) throw new Error(`${label}.line_range must be an object`);
  exactKeys(range, ["start", "end"], `${label}.line_range`);
  const start = positiveInteger(range["start"], `${label}.line_range.start`);
  const end = positiveInteger(range["end"], `${label}.line_range.end`);
  if (end < start) throw new Error(`${label}.line_range.end must be at least start`);
  return { absoluteFilePath: resolvedFilePath, lineRange: { start, end } };
}

function resolveFilePath(value: string, cwd: string | undefined, label: string): string {
  if (cwd === undefined) {
    if (!path.isAbsolute(value)) throw new Error(`${label}.absolute_file_path must be absolute`);
    return value;
  }
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label}.absolute_file_path must stay inside the review checkout`);
  }
  return resolved;
}

function extractSingleObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const candidates = jsonObjectCandidates(trimmed);
    if (candidates.length !== 1)
      throw new Error("review output must contain exactly one JSON object");
    return candidates[0];
  }
}

const REVIEW_MARKER = '"overall_correctness"';
const MAX_OBJECT_DEPTH = 128;
const MAX_CANDIDATE_PARSES = 64;

type ObjectFrame = {
  readonly start: number;
  hasReviewMarker: boolean;
};

type ObjectScanState = {
  readonly frames: ObjectFrame[];
  readonly candidates: unknown[];
  quoted: boolean;
  escaped: boolean;
  parseCount: number;
};

function jsonObjectCandidates(text: string): readonly unknown[] {
  const state: ObjectScanState = {
    frames: [],
    candidates: [],
    quoted: false,
    escaped: false,
    parseCount: 0,
  };
  for (let index = 0; index < text.length; index += 1) scanObjectCharacter(text, index, state);
  return state.candidates;
}

function scanObjectCharacter(text: string, index: number, state: ObjectScanState): void {
  if (text.startsWith(REVIEW_MARKER, index)) markFrames(state.frames);
  const char = text[index] ?? "";
  if (consumeStringCharacter(char, state)) return;
  if (char === "{") pushFrame(state.frames, index);
  if (char === "}") closeFrame(text, index, state);
}

function consumeStringCharacter(char: string, state: ObjectScanState): boolean {
  if (state.escaped) {
    state.escaped = false;
    return true;
  }
  if (!state.quoted) {
    if (char === '"') state.quoted = true;
    return state.quoted;
  }
  if (char === "\\") state.escaped = true;
  else if (char === '"') state.quoted = false;
  return true;
}

function closeFrame(text: string, end: number, state: ObjectScanState): void {
  const frame = state.frames.pop();
  if (frame?.hasReviewMarker !== true) return;
  if (state.parseCount >= MAX_CANDIDATE_PARSES) return;
  state.parseCount += 1;
  collectCandidate(text, frame.start, end, state.candidates);
}

function markFrames(frames: ObjectFrame[]): void {
  for (const frame of frames) frame.hasReviewMarker = true;
}

function pushFrame(frames: ObjectFrame[], start: number): void {
  if (frames.length >= MAX_OBJECT_DEPTH) frames.splice(0, frames.length);
  frames.push({ start, hasReviewMarker: false });
}

function collectCandidate(text: string, start: number, end: number, candidates: unknown[]): void {
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    if (isReviewCandidate(value)) candidates.push(value);
  } catch {
    // Continue searching for a later complete object.
  }
}

function isReviewCandidate(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    "findings" in value &&
    "overall_correctness" in value &&
    "overall_explanation" in value &&
    "overall_confidence_score" in value
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const allowed = new Set(expected);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !allowed.has(key));
  const missing = expected.filter((key) => !(key in value));
  if (unknown.length > 0) throw new Error(`${label} has unknown field ${unknown.join(", ")}`);
  if (missing.length > 0) throw new Error(`${label} is missing field ${missing.join(", ")}`);
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} must be nonempty`);
  return value;
}

function confidence(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
