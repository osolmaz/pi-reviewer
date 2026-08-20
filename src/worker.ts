#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Api, AssistantMessage, Model, Tool, TSchema } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  convertToLlm,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type EventBus,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  createPiFactoryRuntime,
  type PiAppDefinition,
  type PiFactoryRuntime,
} from "@osolmaz/pi-factory";

import { runForcedSubmissionTurn } from "./forced-submission-turn.js";
import { finalizeSessionReceipt, LifecycleEvidence, structuralHash } from "./lifecycle-receipt.js";
import {
  canonicalModelsStorePath,
  registerHuggingFaceOAuthProvider,
} from "./huggingface-provider.js";
import { runThreePhaseReview, type ReviewControllerResult } from "./review-controller.js";
import { ReviewLifecycle } from "./review-lifecycle.js";
import {
  ReviewSubmissionGate,
  createSubmitReviewTool,
  type ReviewSubmission,
} from "./submit-review.js";
import { terminalText } from "./terminal-text.js";
import { readWorkerRequest, type ReviewWorkerRequest } from "./worker-protocol.js";

type ReviewWorkerExecution = {
  readonly subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
  readonly prompt: (prompt: string) => Promise<ReviewControllerResult>;
  readonly submission: () => ReviewSubmission | undefined;
  readonly dispose: () => void | Promise<void>;
  readonly flush: () => Promise<void>;
};

type ReviewWorkerExecutionFactory = (
  request: ReviewWorkerRequest,
) => Promise<ReviewWorkerExecution>;

// eslint-disable-next-line complexity -- Keep durable flush and forced-exit ordering in one worker boundary.
export async function runReviewWorker(
  request: ReviewWorkerRequest,
  createExecution: ReviewWorkerExecutionFactory = createDefaultExecution,
): Promise<void> {
  const execution = await createExecution(request);
  const unsubscribe = execution.subscribe(writeEvent);
  let result: ReviewControllerResult | undefined;
  let failure: Error | undefined;
  try {
    writeJson({ type: "review_started" });
    result = await execution.prompt(request.prompt);
    const submission = execution.submission();
    if (submission !== undefined) writeJson({ type: "review_submission", review: submission });
    if (result.error !== undefined) failure = result.error;
    else if (submission === undefined)
      failure = new Error("review completed without submit_review");
  } catch (error) {
    failure = asError(error);
  } finally {
    unsubscribe();
    await execution.dispose();
    await execution.flush();
  }
  if (result?.forcedExitRequired === true) {
    writeJson({
      type: "shutdown_ready",
      forcedExitRequired: true,
      error: failure?.message ?? "hard finalization transport did not settle",
    });
    await new Promise<void>(() => undefined);
  }
  if (failure !== undefined) throw failure;
}

// The setup stays linear so the reviewed Pi resources and lifecycle wiring are visible together.
// eslint-disable-next-line max-lines-per-function -- Keep the reviewed Pi resources and lifecycle wiring visible together.
export async function createDefaultExecution(
  request: ReviewWorkerRequest,
): Promise<ReviewWorkerExecution> {
  const settingsManager = SettingsManager.create(request.cwd, request.configDir, {
    projectTrusted: false,
  });
  const eventBus = createEventBus();
  const reviewRuntime = await createReviewRuntime(request, settingsManager, eventBus);
  const { modelRuntime, model, resourceLoader } = reviewRuntime;

  const sessionManager = createReviewSessionManager(request);
  const lifecycle = new ReviewLifecycle();
  const evidence = new LifecycleEvidence(lifecycle, request.lifecycleReceipt);
  const gate = new ReviewSubmissionGate(request.cwd);
  const submitReview = createSubmitReviewTool(gate);
  const { session } = await createAgentSession({
    cwd: request.cwd,
    agentDir: request.configDir,
    modelRuntime,
    model,
    thinkingLevel: request.thinking,
    tools: [...new Set([...request.tools, "submit_review"])],
    customTools: [submitReview],
    resourceLoader,
    settingsManager,
    sessionManager,
  });
  const directListeners = new Set<(event: AgentSessionEvent) => void>();
  const unsubscribeEvidence = session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      evidence.recordAssistant(event.message);
    }
  });
  const hardTools: Tool[] = session.state.tools.map((tool) => {
    const parameters: unknown = tool.parameters;
    return {
      name: tool.name,
      description: tool.description,
      parameters: parameters as TSchema,
    };
  });
  const stableSystemPrompt = session.systemPrompt;

  return {
    subscribe: (listener) => {
      directListeners.add(listener);
      const unsubscribe = session.subscribe(listener);
      return () => {
        directListeners.delete(listener);
        unsubscribe();
      };
    },
    prompt: async (prompt) =>
      await reviewRuntime.run(
        session.sessionId,
        async () =>
          await runThreePhaseReview(
            {
              session,
              sessionManager,
              eventBus,
              policy: {
                timeBudgetMs: request.timeBudgetMs,
                warningRemainingMs: request.warningRemainingMs,
                finalizationGraceMs: request.finalizationGraceMs,
                hardFinalizationGraceMs: request.hardFinalizationGraceMs,
              },
              maxModelRequests: request.maxModelRequests,
              gate,
              lifecycle,
              evidence,
              recordStablePrefix: (preSoftLeafId, finalizationPrompt) => {
                if (sessionManager.getLeafId() !== preSoftLeafId) {
                  throw new Error("review session moved before soft finalization");
                }
                evidence.setStructuralHashes({
                  systemPrompt: structuralHash(stableSystemPrompt),
                  contextPrefix: structuralHash(
                    convertToLlm(sessionManager.buildSessionContext().messages),
                  ),
                  finalizationPrompt: structuralHash(finalizationPrompt),
                  orderedTools: structuralHash(hardTools),
                });
              },
              hardFinalize: async (preSoftLeafId, finalizationPrompt) =>
                await runForcedSubmissionTurn({
                  modelRuntime,
                  model,
                  sessionManager,
                  preSoftLeafId,
                  systemPrompt: stableSystemPrompt,
                  tools: hardTools,
                  finalizationPrompt,
                  gate,
                  evidence,
                  deadlineMs: request.hardFinalizationGraceMs,
                  sessionId: session.sessionId,
                  onAssistant: (message) => {
                    evidence.recordAssistant(message);
                    emitDirectAssistant(directListeners, message);
                  },
                }),
            },
            prompt,
          ),
      ),
    submission: () => gate.submission,
    dispose: async () => {
      unsubscribeEvidence();
      session.dispose();
      await reviewRuntime.close();
    },
    flush: async () => {
      await settingsManager.flush();
      await finalizeSessionReceipt(request.sessionReceipt, sessionManager.getSessionFile());
      lifecycle.record({ kind: "session_flushed" });
      await evidence.flush();
    },
  };
}

type ReviewRuntime = {
  readonly modelRuntime: ModelRuntime;
  readonly model: Model<Api>;
  readonly resourceLoader: ResourceLoader;
  readonly run: <T>(runId: string, operation: () => Promise<T>) => Promise<T>;
  readonly close: () => Promise<void>;
};

async function createReviewRuntime(
  request: ReviewWorkerRequest,
  settingsManager: SettingsManager,
  eventBus: EventBus,
): Promise<ReviewRuntime> {
  if (request.runtime.source === "pi") {
    const runtime: PiFactoryRuntime = await createPiFactoryRuntime({
      app: inheritedReviewerApp(request),
      cwd: request.cwd,
      agentDir: request.runtime.agentDir,
      appAgentDir: request.configDir,
      providerId: request.provider,
      modelId: request.model,
      appResources: {
        settingsManager,
        eventBus,
        extensionPaths: [request.extensionPath],
        systemPrompt: request.systemPrompt,
        noContextFiles: true,
      },
      prepareModelRuntime: registerHuggingFaceOAuthProvider,
    });
    return runtime;
  }
  const modelRuntime = await ModelRuntime.create({
    authPath: request.runtime.authPath,
    modelsPath: request.runtime.modelsPath,
    modelsStorePath: canonicalModelsStorePath(request.runtime.authPath),
    allowModelNetwork: false,
  });
  const model = modelRuntime.getModel(request.provider, request.model);
  if (model === undefined) {
    throw new Error(`review model not found: ${request.provider}/${request.model}`);
  }
  if (!(await modelRuntime.checkAuth(request.provider))) {
    throw new Error(`no authentication for review provider ${request.provider}`);
  }
  const resourceLoader = createReviewResourceLoader(request, settingsManager, eventBus);
  await resourceLoader.reload();
  const extensionErrors = resourceLoader.getExtensions().errors;
  if (extensionErrors.length > 0) {
    throw new Error(
      `review extension failed to load: ${extensionErrors.map((entry) => entry.error).join("; ")}`,
    );
  }
  return {
    modelRuntime,
    model,
    resourceLoader,
    run: async <T>(_runId: string, operation: () => Promise<T>) => await operation(),
    close: () => Promise.resolve(),
  };
}

function inheritedReviewerApp(request: ReviewWorkerRequest): PiAppDefinition {
  return {
    id: "pi-reviewer",
    name: "Pi Reviewer",
    stateDir: request.configDir,
    sessionDir: request.sessionDir,
    piCommand: [],
    providers: [
      {
        id: request.provider,
        source: "pi",
        models: [{ id: request.model, reasoning: true }],
      },
    ],
    defaultProvider: request.provider,
    defaultModel: request.model,
    thinking: request.thinking,
    inherit: { providers: [request.provider], packages: [] },
  };
}

function createReviewResourceLoader(
  request: ReviewWorkerRequest,
  settingsManager: SettingsManager,
  eventBus: EventBus,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: request.cwd,
    agentDir: request.configDir,
    settingsManager,
    eventBus,
    additionalExtensionPaths: [request.extensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: request.systemPrompt,
  });
}

export function createReviewSessionManager(request: ReviewWorkerRequest): SessionManager {
  if (!request.persistSession) return SessionManager.inMemory(request.cwd);
  const manager = createInitializedSessionManager(request.cwd, request.sessionDir);
  const sessionFile = manager.getSessionFile();
  if (sessionFile === undefined) throw new Error("Pi did not create a persistent session file");
  if (request.sessionReceipt !== null) {
    const temporaryReceipt = `${request.sessionReceipt}.${String(process.pid)}.tmp`;
    writeFileSync(temporaryReceipt, `${JSON.stringify({ version: 1, sessionFile })}\n`, {
      mode: 0o600,
    });
    renameSync(temporaryReceipt, request.sessionReceipt);
  }
  return manager;
}

function createInitializedSessionManager(cwd: string, sessionDir: string): SessionManager {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(sessionDir, `pi-reviewer-${randomUUID()}.jsonl`);
  writeFileSync(sessionFile, "", { flag: "wx", mode: 0o600 });
  try {
    return SessionManager.open(sessionFile, sessionDir, cwd);
  } catch (error) {
    unlinkSync(sessionFile);
    throw error;
  }
}

function emitDirectAssistant(
  listeners: ReadonlySet<(event: AgentSessionEvent) => void>,
  message: AssistantMessage,
): void {
  const event = { type: "message_end", message } satisfies AgentSessionEvent;
  for (const listener of listeners) listener(event);
}

function writeEvent(event: AgentSessionEvent): void {
  if (event.type === "message_end") {
    writeJson(workerMessagePayload(event.message));
    return;
  }
  if (event.type === "agent_end") {
    writeJson({ type: "agent_end", messages: [] });
    return;
  }
  writeJson({ type: event.type });
}

export function workerMessagePayload(
  message: Readonly<{ role: string }>,
): Readonly<Record<string, unknown>> {
  return message.role === "assistant" ? { type: "message_end", message } : { type: "message_end" };
}

function writeJson(value: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function main(): Promise<void> {
  try {
    await runReviewWorker(await readWorkerRequest());
  } catch (error) {
    process.stderr.write(`${terminalText(asError(error).message)}\n`);
    process.exitCode = 1;
  }
}

if (process.env["PI_REVIEWER_WORKER"] === "1") await main();
