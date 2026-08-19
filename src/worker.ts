#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type EventBus,
} from "@earendil-works/pi-coding-agent";

import { enterReviewFinalization } from "./finalization.js";
import {
  canonicalModelsStorePath,
  registerHuggingFaceOAuthProvider,
} from "./huggingface-provider.js";
import { runReviewWithBudget } from "./review-budget.js";
import { createSubmitReviewTool, type ReviewSubmission } from "./submit-review.js";
import { terminalText } from "./terminal-text.js";
import { readWorkerRequest, type ReviewWorkerRequest } from "./worker-protocol.js";

type ReviewWorkerExecution = {
  readonly subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
  readonly prompt: (prompt: string) => Promise<void>;
  readonly submission: () => ReviewSubmission | undefined;
  readonly dispose: () => void;
  readonly flush: () => Promise<void>;
};

type ReviewWorkerExecutionFactory = (
  request: ReviewWorkerRequest,
) => Promise<ReviewWorkerExecution>;

export async function runReviewWorker(
  request: ReviewWorkerRequest,
  createExecution: ReviewWorkerExecutionFactory = createDefaultExecution,
): Promise<void> {
  const execution = await createExecution(request);
  const unsubscribe = execution.subscribe(writeEvent);
  try {
    writeJson({ type: "review_started" });
    await execution.prompt(request.prompt);
    const submission = execution.submission();
    if (submission === undefined) throw new Error("review completed without submit_review");
    writeJson({ type: "review_submission", review: submission });
  } finally {
    unsubscribe();
    execution.dispose();
    await execution.flush();
  }
}

export async function createDefaultExecution(
  request: ReviewWorkerRequest,
): Promise<ReviewWorkerExecution> {
  const modelRuntime = await ModelRuntime.create({
    authPath: request.authPath,
    modelsPath: request.modelsPath,
    modelsStorePath: canonicalModelsStorePath(request.authPath),
    allowModelNetwork: false,
  });
  if (!request.customModel) await registerHuggingFaceOAuthProvider(modelRuntime);
  const model = modelRuntime.getModel(request.provider, request.model);
  if (model === undefined) {
    throw new Error(`review model not found: ${request.provider}/${request.model}`);
  }
  if (!(await modelRuntime.checkAuth(request.provider))) {
    throw new Error(`no authentication for review provider ${request.provider}`);
  }

  const settingsManager = SettingsManager.create(request.cwd, request.configDir, {
    projectTrusted: false,
  });
  const eventBus = createEventBus();
  const resourceLoader = createReviewResourceLoader(request, settingsManager, eventBus);
  await resourceLoader.reload();
  const extensionErrors = resourceLoader.getExtensions().errors;
  if (extensionErrors.length > 0) {
    throw new Error(
      `review extension failed to load: ${extensionErrors.map((entry) => entry.error).join("; ")}`,
    );
  }

  const sessionManager = createReviewSessionManager(request);
  let submission: ReviewSubmission | undefined;
  const submitReview = createSubmitReviewTool(request.cwd, (value) => {
    submission = value;
  });
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
  return {
    subscribe: (listener) => session.subscribe(listener),
    prompt: async (prompt) => {
      await runReviewWithBudget(
        session,
        prompt,
        {
          timeBudgetMs: request.timeBudgetMs,
          warningRemainingMs: request.warningRemainingMs,
          finalizationGraceMs: request.finalizationGraceMs,
        },
        request.maxModelRequests,
        () => submission !== undefined,
        {
          enterFinalization: () => {
            enterReviewFinalization(session, eventBus);
          },
        },
      );
    },
    submission: () => submission,
    dispose: () => {
      session.dispose();
    },
    flush: async () => {
      await settingsManager.flush();
    },
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

async function main(): Promise<void> {
  try {
    await runReviewWorker(await readWorkerRequest());
  } catch (error) {
    process.stderr.write(
      `${terminalText(error instanceof Error ? error.message : String(error))}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.env["PI_REVIEWER_WORKER"] === "1") await main();
