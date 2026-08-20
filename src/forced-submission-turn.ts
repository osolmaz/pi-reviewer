import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ModelsSimpleStreamOptions,
  Tool,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ModelRuntime,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
  requireForcedSubmissionCapability,
  type NamedSubmitReviewChoice,
} from "./finalization-capabilities.js";
import {
  assistantUsageEvidence,
  type HardRequestEvidence,
  type LifecycleEvidence,
  structuralHash,
} from "./lifecycle-receipt.js";
import { HARD_CANCELLATION_ALLOWANCE_MS } from "./review-lifecycle.js";
import { ReviewSubmissionGate } from "./submit-review.js";

export const LARGEST_MEASURED_VALID_REVIEW_BYTES = 2_693;
export const HARD_FINALIZATION_MAX_TOKENS = 4_096;

export type ForcedSubmissionResult =
  | {
      readonly kind: "accepted";
      readonly assistant: AssistantMessage;
      readonly userEntryId: string;
      readonly assistantEntryId: string;
      readonly toolResultEntryId: string;
    }
  | { readonly kind: "failed"; readonly error: Error; readonly forcedExitRequired: boolean };

type ForcedSimpleOptions = Omit<ModelsSimpleStreamOptions, "reasoning"> & {
  readonly reasoning: "off";
  readonly toolChoice: NamedSubmitReviewChoice;
};

type ForcedSubmissionInput = {
  readonly modelRuntime: Pick<ModelRuntime, "getProvider" | "streamSimple">;
  readonly model: Model<Api>;
  readonly sessionManager: SessionManager;
  readonly preSoftLeafId: string;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly finalizationPrompt: string;
  readonly gate: ReviewSubmissionGate;
  readonly evidence: LifecycleEvidence;
  readonly deadlineMs: number;
  readonly cancellationAllowanceMs?: number;
  readonly sessionId: string;
  readonly onAssistant?: (message: AssistantMessage) => void;
  readonly now?: () => Date;
};

// The phase contract is easier to audit when dispatch, cancellation, evidence, and persistence stay together.
// eslint-disable-next-line complexity, max-lines-per-function -- Keep the auditable dispatch and cleanup contract together.
export async function runForcedSubmissionTurn(
  input: ForcedSubmissionInput,
): Promise<ForcedSubmissionResult> {
  const now = input.now ?? (() => new Date());
  input.sessionManager.branch(input.preSoftLeafId);
  const restored = input.sessionManager.buildSessionContext();
  const contextPrefix = convertToLlm(restored.messages);
  const userMessage: UserMessage = {
    role: "user",
    content: input.finalizationPrompt,
    timestamp: now().getTime(),
  };
  const context: Context = {
    systemPrompt: input.systemPrompt,
    messages: [...contextPrefix, userMessage],
    tools: [...input.tools],
  };
  input.evidence.setStructuralHashes({
    systemPrompt: structuralHash(input.systemPrompt),
    contextPrefix: structuralHash(contextPrefix),
    finalizationPrompt: structuralHash(input.finalizationPrompt),
    orderedTools: structuralHash(input.tools),
  });
  // Pi has already compacted this branch when needed. Only the provider knows the exact
  // token count after applying its chat template, tool serialization, and tokenizer.
  if (input.model.maxTokens < HARD_FINALIZATION_MAX_TOKENS) {
    return failed(
      new Error(
        `review model output limit ${String(input.model.maxTokens)} is below the hard-finalization allowance ${String(HARD_FINALIZATION_MAX_TOKENS)}`,
      ),
    );
  }

  let toolChoice: NamedSubmitReviewChoice;
  try {
    toolChoice = requireForcedSubmissionCapability(input.modelRuntime, input.model);
  } catch (error) {
    return failed(asError(error));
  }

  const controller = new AbortController();
  const eventCounts: Record<string, number> = {};
  let streamedCharacters = 0;
  let responseHeaderAt: string | undefined;
  let firstStreamAt: string | undefined;
  let lastStreamAt: string | undefined;
  const dispatchedAt = now().toISOString();
  const options: ForcedSimpleOptions = {
    signal: controller.signal,
    timeoutMs: input.deadlineMs,
    maxRetries: 0,
    maxTokens: HARD_FINALIZATION_MAX_TOKENS,
    sessionId: input.sessionId,
    reasoning: "off",
    toolChoice,
    onResponse: () => {
      responseHeaderAt ??= now().toISOString();
    },
  };

  let stream;
  try {
    setHardEvidence(input, {
      dispatchedAt,
      eventCounts,
      streamedCharacters,
      toolChoice,
    });
    // Pi AI 0.84.2 adapters publicly support the model-level "off" value, but the
    // generic streamSimple option type narrows reasoning to enabled levels only.
    stream = input.modelRuntime.streamSimple(
      input.model,
      context,
      options as unknown as ModelsSimpleStreamOptions,
    );
  } catch (error) {
    return failed(asError(error));
  }
  const consumption = consumeAssistant(stream, (event) => {
    const timestamp = now().toISOString();
    firstStreamAt ??= timestamp;
    lastStreamAt = timestamp;
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    streamedCharacters += eventCharacterCount(event);
  });
  const outcome = await raceDeadline(consumption, input.deadlineMs);
  if (outcome.kind === "timeout") {
    controller.abort();
    const cancellation = await raceDeadline(
      consumption,
      input.cancellationAllowanceMs ?? HARD_CANCELLATION_ALLOWANCE_MS,
    );
    setHardEvidence(input, {
      dispatchedAt,
      ...(responseHeaderAt === undefined ? {} : { responseHeaderAt }),
      ...(firstStreamAt === undefined ? {} : { firstStreamAt }),
      ...(lastStreamAt === undefined ? {} : { lastStreamAt }),
      ...(cancellation.kind === "timeout" ? {} : { settledAt: now().toISOString() }),
      eventCounts,
      streamedCharacters,
      toolChoice,
      ...(cancellation.kind === "settled" ? { message: cancellation.value } : {}),
    });
    if (cancellation.kind === "timeout") {
      void consumption.catch(() => undefined);
      return failed(
        new Error("hard finalization transport did not settle after cancellation"),
        true,
      );
    }
    if (cancellation.kind === "settled") {
      try {
        persistHardAssistant(input, userMessage, cancellation.value);
      } catch (error) {
        return failed(asError(error));
      }
    }
    return failed(
      new Error("hard finalization exceeded its request deadline", {
        ...(cancellation.kind === "rejected" ? { cause: cancellation.error } : {}),
      }),
    );
  }
  if (outcome.kind === "rejected") {
    setHardEvidence(input, {
      dispatchedAt,
      ...(responseHeaderAt === undefined ? {} : { responseHeaderAt }),
      ...(firstStreamAt === undefined ? {} : { firstStreamAt }),
      ...(lastStreamAt === undefined ? {} : { lastStreamAt }),
      settledAt: now().toISOString(),
      eventCounts,
      streamedCharacters,
      toolChoice,
    });
    return failed(asError(outcome.error));
  }
  const assistant = outcome.value;
  setHardEvidence(input, {
    dispatchedAt,
    ...(responseHeaderAt === undefined ? {} : { responseHeaderAt }),
    ...(firstStreamAt === undefined ? {} : { firstStreamAt }),
    ...(lastStreamAt === undefined ? {} : { lastStreamAt }),
    settledAt: now().toISOString(),
    eventCounts,
    streamedCharacters,
    toolChoice,
    message: assistant,
  });

  let persisted: { readonly userEntryId: string; readonly assistantEntryId: string };
  try {
    persisted = persistHardAssistant(input, userMessage, assistant);
    attestAssistantRoute(assistant, input.model);
    const call = requireSingleSubmissionCall(assistant);
    const submission = input.gate.accept(call.arguments);
    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: "submit_review",
      content: [{ type: "text", text: "Final review submitted." }],
      details: submission,
      isError: false,
      timestamp: now().getTime(),
    };
    const toolResultEntryId = input.sessionManager.appendMessage(toolResult);
    return { kind: "accepted", assistant, ...persisted, toolResultEntryId };
  } catch (error) {
    return failed(asError(error));
  }
}

// eslint-disable-next-line complexity -- Keep all mutually exclusive response rejection rules in one validator.
export function requireSingleSubmissionCall(message: AssistantMessage): ToolCall {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage ?? `hard finalization response ${message.stopReason}`);
  }
  const calls = message.content.filter((entry): entry is ToolCall => entry.type === "toolCall");
  if (calls.length !== 1) {
    throw new Error(
      `hard finalization must return exactly one tool call; received ${String(calls.length)}`,
    );
  }
  const call = calls[0];
  if (call?.name !== "submit_review") {
    throw new Error(`hard finalization returned disallowed tool ${call?.name ?? "unknown"}`);
  }
  const actionable = message.content.some(
    (entry) =>
      (entry.type === "text" && entry.text.trim() !== "") ||
      (entry.type === "thinking" && entry.thinking.trim() !== ""),
  );
  if (actionable) throw new Error("hard finalization returned content outside submit_review");
  return call;
}

async function consumeAssistant(
  stream: ReturnType<ModelRuntime["streamSimple"]>,
  onEvent: (event: AssistantMessageEvent) => void,
): Promise<AssistantMessage> {
  let terminal: AssistantMessage | undefined;
  for await (const event of stream) {
    onEvent(event);
    if (event.type === "done") terminal = event.message;
    if (event.type === "error") terminal = event.error;
  }
  return terminal ?? (await stream.result());
}

async function raceDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<
  | { readonly kind: "settled"; readonly value: T }
  | { readonly kind: "rejected"; readonly error: unknown }
  | { readonly kind: "timeout" }
> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ readonly kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      operation.then(
        (value) => ({ kind: "settled" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function setHardEvidence(
  input: ForcedSubmissionInput,
  values: {
    readonly dispatchedAt: string;
    readonly responseHeaderAt?: string;
    readonly firstStreamAt?: string;
    readonly lastStreamAt?: string;
    readonly settledAt?: string;
    readonly eventCounts: Readonly<Record<string, number>>;
    readonly streamedCharacters: number;
    readonly toolChoice: NamedSubmitReviewChoice;
    readonly message?: AssistantMessage;
  },
): void {
  const route =
    values.message === undefined
      ? { provider: input.model.provider, model: input.model.id, api: input.model.api }
      : assistantUsageEvidence(values.message);
  const evidence: HardRequestEvidence = {
    ...route,
    dispatchedAt: values.dispatchedAt,
    ...(values.responseHeaderAt === undefined ? {} : { responseHeaderAt: values.responseHeaderAt }),
    ...(values.firstStreamAt === undefined ? {} : { firstStreamAt: values.firstStreamAt }),
    ...(values.lastStreamAt === undefined ? {} : { lastStreamAt: values.lastStreamAt }),
    ...(values.settledAt === undefined ? {} : { settledAt: values.settledAt }),
    reasoning: "off",
    toolChoice: values.toolChoice,
    maxRetries: 0,
    maxTokens: HARD_FINALIZATION_MAX_TOKENS,
    deadlineMs: input.deadlineMs,
    streamEventCounts: values.eventCounts,
    streamedCharacters: values.streamedCharacters,
  };
  input.evidence.setHardRequest(evidence);
}

function persistHardAssistant(
  input: ForcedSubmissionInput,
  userMessage: UserMessage,
  assistant: AssistantMessage,
): { readonly userEntryId: string; readonly assistantEntryId: string } {
  const userEntryId = input.sessionManager.appendMessage(userMessage);
  const assistantEntryId = input.sessionManager.appendMessage(assistant);
  input.onAssistant?.(assistant);
  return { userEntryId, assistantEntryId };
}

function attestAssistantRoute(message: AssistantMessage, model: Model<Api>): void {
  if (
    message.provider !== model.provider ||
    message.model !== model.id ||
    message.api !== model.api
  ) {
    throw new Error("hard finalization response route does not match the requested model");
  }
}

function eventCharacterCount(event: AssistantMessageEvent): number {
  if (
    event.type === "text_delta" ||
    event.type === "thinking_delta" ||
    event.type === "toolcall_delta"
  ) {
    return event.delta.length;
  }
  if (event.type === "text_end" || event.type === "thinking_end") return event.content.length;
  if (event.type === "toolcall_end") return JSON.stringify(event.toolCall.arguments).length;
  return 0;
}

function failed(error: Error, forcedExitRequired = false): ForcedSubmissionResult {
  return { kind: "failed", error, forcedExitRequired };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
