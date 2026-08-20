import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ModelsSimpleStreamOptions,
  type SimpleStreamOptions,
  Type,
} from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamPiMessages } from "@earendil-works/pi-ai/api/pi-messages";
import { SessionManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HARD_FINALIZATION_MAX_TOKENS,
  LARGEST_MEASURED_VALID_REVIEW_BYTES,
  runForcedSubmissionTurn,
} from "../src/forced-submission-turn.js";
import { LifecycleEvidence } from "../src/lifecycle-receipt.js";
import { ReviewLifecycle } from "../src/review-lifecycle.js";
import { ReviewSubmissionGate } from "../src/submit-review.js";

const cleanup: string[] = [];
const MODEL: Model<"openai-completions"> = {
  id: "review-model",
  name: "Review Model",
  api: "openai-completions",
  provider: "custom",
  baseUrl: "https://example.invalid/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131_072,
  maxTokens: 16_384,
};
const SHORT_CONTEXT_MODEL: Model<"openai-completions"> = {
  ...MODEL,
  contextWindow: 32_768,
};
const PI_MESSAGES_MODEL: Model<"pi-messages"> = {
  id: MODEL.id,
  name: MODEL.name,
  api: "pi-messages",
  provider: MODEL.provider,
  baseUrl: MODEL.baseUrl,
  reasoning: MODEL.reasoning,
  input: MODEL.input,
  cost: MODEL.cost,
  contextWindow: MODEL.contextWindow,
  maxTokens: MODEL.maxTokens,
};

const TOOLS = [
  { name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) },
  {
    name: "submit_review",
    description: "Submit",
    parameters: Type.Object({ findings: Type.Array(Type.Unknown()) }),
  },
] as const;
type ExplicitOffOptions = Omit<SimpleStreamOptions, "reasoning"> & {
  reasoning: "off";
  toolChoice: { type: "function"; function: { name: string } };
};

const SUBMISSION = {
  findings: [],
  overall_correctness: "patch is correct",
  overall_explanation: "No defect found.",
  overall_confidence_score: 0.9,
} as const;

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function assistant(): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-1",
        name: "submit_review",
        arguments: SUBMISSION,
      },
    ],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    responseModel: "served-review-model",
    usage: {
      input: 100,
      output: 20,
      cacheRead: 80,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 120,
      cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  };
}

function completedStream(message = assistant()): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
  const call = message.content.find((entry) => entry.type === "toolCall");
  if (call?.type === "toolCall") {
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
  }
  stream.push({ type: "done", reason: "toolUse", message });
  stream.end(message);
  return stream;
}

function providerErrorStream(errorMessage: string): AssistantMessageEventStream {
  const message: AssistantMessage = {
    ...assistant(),
    content: [],
    stopReason: "error",
    errorMessage,
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "error", reason: "error", error: message });
  stream.end(message);
  return stream;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-reviewer-hard-"));
  cleanup.push(root);
  const sessionFile = path.join(root, "session.jsonl");
  await writeFile(sessionFile, "", { mode: 0o600 });
  const manager = SessionManager.open(sessionFile, root, root);
  manager.appendMessage({ role: "user", content: "explore", timestamp: 1 });
  manager.appendMessage({ ...assistant(), content: [{ type: "text", text: "exploration" }] });
  const preSoftLeafId = manager.getLeafId();
  if (preSoftLeafId === null) throw new Error("missing pre-soft leaf");
  manager.appendMessage({ role: "user", content: "finalize", timestamp: 2 });
  manager.appendMessage({ ...assistant(), content: [{ type: "text", text: "failed soft" }] });
  const softLeafId = manager.getLeafId();
  const lifecycle = new ReviewLifecycle();
  lifecycle.transition("quiescing_before_soft", "deadline");
  lifecycle.transition("soft_finalizing", "idle");
  lifecycle.transition("quiescing_before_hard", "missing");
  lifecycle.transition("hard_finalizing", "idle");
  const evidence = new LifecycleEvidence(lifecycle, null);
  evidence.setBranches(preSoftLeafId, softLeafId ?? undefined);
  return { root, manager, preSoftLeafId, softLeafId, evidence };
}

function runtimeWith(
  streamFactory: (options: Record<string, unknown>) => AssistantMessageEventStream,
) {
  const captured: {
    context?: Context;
    options: ModelsSimpleStreamOptions | undefined;
  } = { options: undefined };
  const dispatch = vi.fn(
    (_model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) => {
      captured.context = context;
      captured.options = options;
      if (options?.onResponse !== undefined) {
        void options.onResponse({ status: 200, headers: {} }, _model);
      }
      return streamFactory((options ?? {}) as Record<string, unknown>);
    },
  );
  const runtime = {
    getProvider: () => ({ streamSimple: dispatch }),
    streamSimple: dispatch,
  } as unknown as Pick<ModelRuntime, "getProvider" | "streamSimple">;
  return { runtime, dispatch, captured };
}

// eslint-disable-next-line max-lines-per-function
describe("forced submission turn", () => {
  it("pins the tested Pi and Pi AI compatibility surface", async () => {
    const codingAgent = JSON.parse(
      await readFile("node_modules/@earendil-works/pi-coding-agent/package.json", "utf8"),
    ) as { version: string };
    const piAi = JSON.parse(
      await readFile("node_modules/@earendil-works/pi-ai/package.json", "utf8"),
    ) as { version: string };
    expect(codingAgent.version).toBe("0.84.2");
    expect(piAi.version).toBe("0.84.2");
  });

  // eslint-disable-next-line complexity
  it("branches from pre-soft state and sends one stable forced payload", async () => {
    const { manager, preSoftLeafId, softLeafId, evidence } = await fixture();
    const { runtime, dispatch, captured } = runtimeWith(() => completedStream());
    let hardMessage: AssistantMessage | undefined;
    let hardMetricMessages = 0;
    const result = await runForcedSubmissionTurn({
      modelRuntime: runtime,
      model: MODEL,
      sessionManager: manager,
      preSoftLeafId,
      systemPrompt: "stable system prompt",
      tools: TOOLS,
      finalizationPrompt: "stable finalization prompt",
      gate: new ReviewSubmissionGate(manager.getCwd()),
      evidence,
      deadlineMs: 120_000,
      sessionId: "session-1",
      onAssistant: (message) => {
        hardMetricMessages += 1;
        hardMessage = message;
        evidence.recordAssistant(message);
      },
    });

    expect(result.kind).toBe("accepted");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(captured.context?.systemPrompt).toBe("stable system prompt");
    expect(captured.context?.tools).toEqual(TOOLS);
    expect(JSON.stringify(captured.context?.messages.at(-1))).toContain(
      "stable finalization prompt",
    );
    expect(JSON.stringify(captured.context)).not.toContain("failed soft");
    expect(captured.options?.maxRetries).toBe(0);
    expect(captured.options?.maxTokens).toBe(HARD_FINALIZATION_MAX_TOKENS);
    expect(captured.options?.sessionId).toBe("session-1");
    expect(captured.options).toHaveProperty("toolChoice", {
      type: "function",
      function: { name: "submit_review" },
    });
    expect(captured.options).toHaveProperty("reasoning", "off");
    expect(hardMessage?.responseModel).toBe("served-review-model");
    expect(hardMetricMessages).toBe(1);

    const softPath = manager.getBranch(softLeafId ?? undefined);
    expect(JSON.stringify(softPath)).toContain("failed soft");
    const hardPath = manager.getBranch();
    expect(JSON.stringify(hardPath)).not.toContain("failed soft");
    expect(
      hardPath
        .slice(-3)
        .map((entry) => (entry.type === "message" ? entry.message.role : entry.type)),
    ).toEqual(["user", "assistant", "toolResult"]);
    const hardUser = hardPath.at(-3);
    expect(hardUser?.parentId).toBe(preSoftLeafId);
    const receipt = evidence.snapshot();
    expect(Object.values(receipt.structuralHashes ?? {})).toHaveLength(4);
    for (const hash of Object.values(receipt.structuralHashes ?? {})) {
      expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(receipt.responses).toHaveLength(1);
    expect(receipt.responses[0]?.usage).toEqual(hardMessage?.usage);
    expect(receipt.hardRequest).toMatchObject({
      reasoning: "off",
      maxRetries: 0,
      deadlineMs: 120_000,
      provider: "custom",
      model: "review-model",
      responseModel: "served-review-model",
      usage: assistant().usage,
    });
  });

  it("lets the provider enforce context admission", async () => {
    const { manager, preSoftLeafId, evidence } = await fixture();
    const { runtime, dispatch, captured } = runtimeWith(() => completedStream());
    const result = await runForcedSubmissionTurn({
      modelRuntime: runtime,
      model: SHORT_CONTEXT_MODEL,
      sessionManager: manager,
      preSoftLeafId,
      systemPrompt: "system".repeat(12_000),
      tools: TOOLS,
      finalizationPrompt: "finalize",
      gate: new ReviewSubmissionGate(manager.getCwd()),
      evidence,
      deadlineMs: 120_000,
      sessionId: "session-1",
    });

    expect(result.kind).toBe("accepted");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(
      Math.ceil(Buffer.byteLength(JSON.stringify(captured.context), "utf8") / 2) +
        HARD_FINALIZATION_MAX_TOKENS,
    ).toBeGreaterThan(SHORT_CONTEXT_MODEL.contextWindow);
  });

  it("records a provider context rejection after one dispatch", async () => {
    const { manager, preSoftLeafId, evidence } = await fixture();
    const { runtime, dispatch } = runtimeWith(() =>
      providerErrorStream("provider context limit exceeded"),
    );
    const result = await runForcedSubmissionTurn({
      modelRuntime: runtime,
      model: SHORT_CONTEXT_MODEL,
      sessionManager: manager,
      preSoftLeafId,
      systemPrompt: "system",
      tools: TOOLS,
      finalizationPrompt: "finalize",
      gate: new ReviewSubmissionGate(manager.getCwd()),
      evidence,
      deadlineMs: 120_000,
      sessionId: "session-1",
      onAssistant: (message) => {
        evidence.recordAssistant(message);
      },
    });

    expect(result).toMatchObject({ kind: "failed", forcedExitRequired: false });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(evidence.snapshot()).toMatchObject({
      hardRequest: {
        maxRetries: 0,
        maxTokens: HARD_FINALIZATION_MAX_TOKENS,
        streamEventCounts: { error: 1 },
      },
      responses: [{ stopReason: "error" }],
      submission: { acceptedCallCount: 0 },
    });
    expect(JSON.stringify(manager.getBranch())).toContain("provider context limit exceeded");
  });

  it("persists and reports a billed hard response before validation rejects it", async () => {
    const { manager, preSoftLeafId, evidence } = await fixture();
    const invalid = {
      ...assistant(),
      content: [{ type: "text" as const, text: "prose instead of submit_review" }],
      stopReason: "stop" as const,
    };
    const { runtime } = runtimeWith(() => completedStream(invalid));
    let metricMessages = 0;
    const result = await runForcedSubmissionTurn({
      modelRuntime: runtime,
      model: MODEL,
      sessionManager: manager,
      preSoftLeafId,
      systemPrompt: "system",
      tools: TOOLS,
      finalizationPrompt: "finalize",
      gate: new ReviewSubmissionGate(manager.getCwd()),
      evidence,
      deadlineMs: 100,
      sessionId: "session-1",
      onAssistant: (message) => {
        metricMessages += 1;
        evidence.recordAssistant(message);
      },
    });
    expect(result.kind).toBe("failed");
    expect(metricMessages).toBe(1);
    expect(evidence.snapshot().responses).toHaveLength(1);
    expect(
      manager
        .getBranch()
        .slice(-2)
        .map((entry) => (entry.type === "message" ? entry.message.role : entry.type)),
    ).toEqual(["user", "assistant"]);
    expect(JSON.stringify(manager.getBranch())).toContain("prose instead of submit_review");
  });

  it("serializes named tool choice and reasoning-off through the pinned public adapter", async () => {
    let payload: unknown;
    const options: ExplicitOffOptions = {
      apiKey: "test-only",
      reasoning: "off",
      maxRetries: 0,
      maxTokens: HARD_FINALIZATION_MAX_TOKENS,
      toolChoice: { type: "function", function: { name: "submit_review" } },
      onPayload: (value) => {
        payload = value;
        throw new Error("payload captured before dispatch");
      },
    };
    const stream = streamOpenAICompletions(
      MODEL,
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "finalize", timestamp: 1 }],
        tools: [...TOOLS],
      },
      options as unknown as SimpleStreamOptions,
    );
    for await (const event of stream) {
      expect(event.type).toBe("error");
    }
    if (!isRecord(payload)) throw new Error("adapter did not expose a request payload");
    expect(payload["model"]).toBe("review-model");
    expect(payload["max_completion_tokens"]).toBe(HARD_FINALIZATION_MAX_TOKENS);
    expect(payload["tool_choice"]).toEqual({
      type: "function",
      function: { name: "submit_review" },
    });
    expect(JSON.stringify(payload["tools"])).toContain('"name":"read"');
    expect(JSON.stringify(payload["tools"])).toContain('"name":"submit_review"');
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("serializes explicit reasoning-off and named tool choice through Pi Messages", async () => {
    let payload: unknown;
    const options: ExplicitOffOptions = {
      apiKey: "test-only",
      reasoning: "off",
      maxRetries: 0,
      maxTokens: HARD_FINALIZATION_MAX_TOKENS,
      toolChoice: { type: "function", function: { name: "submit_review" } },
      onPayload: (value) => {
        payload = value;
        throw new Error("payload captured before dispatch");
      },
    };
    const stream = streamPiMessages(
      PI_MESSAGES_MODEL,
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "finalize", timestamp: 1 }],
        tools: [...TOOLS],
      },
      options as unknown as SimpleStreamOptions,
    );
    for await (const event of stream) {
      expect(event.type).toBe("error");
    }
    if (!isRecord(payload)) throw new Error("Pi Messages did not expose a request payload");
    expect(payload["options"]).toMatchObject({
      reasoning: "off",
      toolChoice: { type: "function", function: { name: "submit_review" } },
    });
  });

  it("uses a measured bounded response allowance with a documented safety margin", () => {
    expect(LARGEST_MEASURED_VALID_REVIEW_BYTES).toBe(2_693);
    const conservativeMeasuredTokens = Math.ceil(LARGEST_MEASURED_VALID_REVIEW_BYTES / 2);
    expect(HARD_FINALIZATION_MAX_TOKENS).toBeGreaterThanOrEqual(conservativeMeasuredTokens * 3);
    expect(HARD_FINALIZATION_MAX_TOKENS).toBeLessThanOrEqual(16_384);
  });

  it("fails unsupported routes before network dispatch", async () => {
    for (const api of ["anthropic-messages"] as const) {
      const { manager, preSoftLeafId, evidence } = await fixture();
      const { runtime, dispatch } = runtimeWith(() => completedStream());
      const result = await runForcedSubmissionTurn({
        modelRuntime: runtime,
        model: { ...MODEL, api },
        sessionManager: manager,
        preSoftLeafId,
        systemPrompt: "system",
        tools: TOOLS,
        finalizationPrompt: "finalize",
        gate: new ReviewSubmissionGate(manager.getCwd()),
        evidence,
        deadlineMs: 100,
        sessionId: "session-1",
      });
      expect(result).toMatchObject({ kind: "failed", forcedExitRequired: false });
      expect(dispatch).not.toHaveBeenCalled();
    }
  });

  it("cancels an expired request and reports settled cancellation", async () => {
    vi.useFakeTimers();
    const { manager, preSoftLeafId, evidence } = await fixture();
    const { runtime } = runtimeWith((options) => {
      const stream = createAssistantMessageEventStream();
      const signal = options["signal"] as AbortSignal;
      signal.addEventListener("abort", () => {
        const message = { ...assistant(), content: [], stopReason: "aborted" as const };
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end(message);
      });
      return stream;
    });
    const operation = runForcedSubmissionTurn({
      modelRuntime: runtime,
      model: MODEL,
      sessionManager: manager,
      preSoftLeafId,
      systemPrompt: "system",
      tools: TOOLS,
      finalizationPrompt: "finalize",
      gate: new ReviewSubmissionGate(manager.getCwd()),
      evidence,
      deadlineMs: 10,
      cancellationAllowanceMs: 20,
      sessionId: "session-1",
    });
    await vi.advanceTimersByTimeAsync(10);
    const result = await operation;
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("expected failed cancellation");
    expect(result.forcedExitRequired).toBe(false);
    expect(result.error.message).toContain("deadline");
  });

  it("accepts delayed transport settlement inside the cancellation allowance", async () => {
    vi.useFakeTimers();
    const { manager, preSoftLeafId, evidence } = await fixture();
    const { runtime } = runtimeWith((options) => {
      const stream = createAssistantMessageEventStream();
      const signal = options["signal"] as AbortSignal;
      signal.addEventListener("abort", () => {
        setTimeout(() => {
          const message = { ...assistant(), content: [], stopReason: "aborted" as const };
          stream.push({ type: "error", reason: "aborted", error: message });
          stream.end(message);
        }, 5);
      });
      return stream;
    });
    const operation = runForcedSubmissionTurn({
      modelRuntime: runtime,
      model: MODEL,
      sessionManager: manager,
      preSoftLeafId,
      systemPrompt: "system",
      tools: TOOLS,
      finalizationPrompt: "finalize",
      gate: new ReviewSubmissionGate(manager.getCwd()),
      evidence,
      deadlineMs: 10,
      cancellationAllowanceMs: 20,
      sessionId: "session-1",
    });
    await vi.advanceTimersByTimeAsync(15);
    await expect(operation).resolves.toMatchObject({
      kind: "failed",
      forcedExitRequired: false,
    });
  });

  it("contains a late transport rejection after abort", async () => {
    vi.useFakeTimers();
    const { manager, preSoftLeafId, evidence } = await fixture();
    const { runtime } = runtimeWith((options) => {
      const signal = options["signal"] as AbortSignal;
      const stream = {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => {
                  resolve();
                });
              });
              throw new Error("late rejection");
            },
          };
        },
        result: () => Promise.reject(new Error("late rejection")),
      } as unknown as AssistantMessageEventStream;
      return stream;
    });
    const operation = runForcedSubmissionTurn({
      modelRuntime: runtime,
      model: MODEL,
      sessionManager: manager,
      preSoftLeafId,
      systemPrompt: "system",
      tools: TOOLS,
      finalizationPrompt: "finalize",
      gate: new ReviewSubmissionGate(manager.getCwd()),
      evidence,
      deadlineMs: 10,
      cancellationAllowanceMs: 20,
      sessionId: "session-1",
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(operation).resolves.toMatchObject({
      kind: "failed",
      forcedExitRequired: false,
    });
  });

  it("marks ignored aborts for bounded parent SIGTERM cleanup", async () => {
    vi.useFakeTimers();
    const { manager, preSoftLeafId, evidence } = await fixture();
    const { runtime } = runtimeWith(() => createAssistantMessageEventStream());
    const operation = runForcedSubmissionTurn({
      modelRuntime: runtime,
      model: MODEL,
      sessionManager: manager,
      preSoftLeafId,
      systemPrompt: "system",
      tools: TOOLS,
      finalizationPrompt: "finalize",
      gate: new ReviewSubmissionGate(manager.getCwd()),
      evidence,
      deadlineMs: 10,
      cancellationAllowanceMs: 20,
      sessionId: "session-1",
    });
    await vi.advanceTimersByTimeAsync(30);
    await expect(operation).resolves.toMatchObject({
      kind: "failed",
      forcedExitRequired: true,
    });
  });

  it("persists private append-only native JSONL evidence", async () => {
    const { root, manager, preSoftLeafId, evidence } = await fixture();
    const { runtime } = runtimeWith(() => completedStream());
    await runForcedSubmissionTurn({
      modelRuntime: runtime,
      model: MODEL,
      sessionManager: manager,
      preSoftLeafId,
      systemPrompt: "system",
      tools: TOOLS,
      finalizationPrompt: "finalize",
      gate: new ReviewSubmissionGate(root),
      evidence,
      deadlineMs: 100,
      sessionId: "session-1",
    });
    const file = manager.getSessionFile();
    if (file === undefined) throw new Error("missing session file");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const entries = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.length).toBeGreaterThan(6);
    expect(JSON.stringify(entries)).toContain("served-review-model");
    expect(JSON.stringify(entries)).toContain('"cacheRead":80');
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
