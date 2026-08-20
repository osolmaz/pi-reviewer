import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import { writePiRuntimeConfig, type PiAppDefinition } from "@osolmaz/pi-factory";

import { regularPiAuthPath } from "./auth-path.js";
import { recordParentTermination } from "./lifecycle-receipt.js";
import { PiEventCollector, type PiRunMetrics } from "./pi-events.js";
import { parseReviewOutput } from "./review-output.js";
import {
  resolveReviewTimePolicy,
  workerWatchdogTimeoutMs,
  type ReviewTimePolicy,
} from "./review-budget.js";
import { selectAppModel } from "./app.js";
import type { CustomModelManifest, ModelSelection, ReviewOutput, TimeWarning } from "./types.js";
import type { ReviewWorkerRequest } from "./worker-protocol.js";

const TERMINATION_GRACE_MS = 2_000;
const WORKER_STARTUP_TIMEOUT_MS = 60_000;
const MAX_STDERR_BYTES = 128 * 1024;

type WorkerProcess = Pick<ChildProcessWithoutNullStreams, "kill" | "pid">;
type WorkerTerminator = (child: WorkerProcess, force?: boolean) => void;

export type RunReviewInput = {
  readonly app: PiAppDefinition;
  readonly selection: ModelSelection;
  readonly modelManifest?: CustomModelManifest;
  readonly persistSession?: boolean;
  readonly sessionDir?: string;
  readonly sessionReceipt?: string;
  readonly lifecycleReceipt?: string;
  readonly maxModelRequests?: number;
  readonly timeBudgetMs?: number;
  readonly timeWarnings?: readonly TimeWarning[];
  readonly finalizationGraceMs?: number;
  readonly hardFinalizationGraceMs?: number;
  readonly cwd: string;
  readonly prompt: string;
  readonly stderr?: NodeJS.WritableStream;
  readonly onMetrics?: (metrics: PiRunMetrics) => void;
};

export async function runReview(input: RunReviewInput): Promise<ReviewOutput> {
  const policy = resolveReviewTimePolicy(
    input.timeBudgetMs,
    input.timeWarnings,
    input.finalizationGraceMs,
    input.hardFinalizationGraceMs,
  );
  const app = selectAppModel(input.app, input.selection, input.modelManifest);
  const runtime = await writePiRuntimeConfig(app);
  const extension = app.extensions?.[0];
  if (extension === undefined) throw new Error("Pi Reviewer extension is not configured");
  if (app.systemPrompt === undefined)
    throw new Error("Pi Reviewer system prompt is not configured");
  const request = createWorkerRequest(
    input,
    app,
    extension.path,
    app.systemPrompt,
    runtime.modelsPath,
    runtime.configDir,
    policy,
  );
  const finalText = await executeWorker(
    app.piCommand,
    request,
    app.env,
    input.stderr,
    input.onMetrics,
    workerWatchdogTimeoutMs(policy),
    request.lifecycleReceipt,
  );
  return parseReviewOutput(finalText, input.cwd);
}

function createWorkerRequest(
  input: RunReviewInput,
  app: PiAppDefinition,
  extensionPath: string,
  systemPrompt: string,
  modelsPath: string,
  configDir: string,
  policy: ReviewTimePolicy,
): ReviewWorkerRequest {
  return {
    version: 1,
    cwd: input.cwd,
    prompt: input.prompt,
    authPath: regularPiAuthPath(),
    modelsPath,
    configDir,
    extensionPath,
    systemPrompt,
    provider: input.selection.provider,
    model: input.selection.model,
    customModel: input.modelManifest !== undefined,
    ...sessionRequestOptions(input),
    maxModelRequests: input.maxModelRequests ?? null,
    timeBudgetMs: policy.timeBudgetMs,
    warningRemainingMs: policy.warningRemainingMs,
    finalizationGraceMs: policy.finalizationGraceMs,
    hardFinalizationGraceMs: policy.hardFinalizationGraceMs,
    thinking: input.selection.thinking,
    tools: app.tools?.split(",").filter((tool) => tool !== "") ?? [],
  };
}

function sessionRequestOptions(
  input: RunReviewInput,
): Pick<
  ReviewWorkerRequest,
  "persistSession" | "sessionDir" | "sessionReceipt" | "lifecycleReceipt"
> {
  const persistSession = input.persistSession ?? true;
  if (
    !persistSession &&
    (input.sessionReceipt !== undefined || input.lifecycleReceipt !== undefined)
  ) {
    throw new Error("session and lifecycle receipts require persistent sessions");
  }
  return {
    persistSession,
    sessionDir: input.sessionDir ?? input.app.sessionDir,
    sessionReceipt: input.sessionReceipt ?? null,
    lifecycleReceipt:
      input.lifecycleReceipt === undefined ? null : path.resolve(input.cwd, input.lifecycleReceipt),
  };
}

async function executeWorker(
  command: readonly string[],
  request: ReviewWorkerRequest,
  appEnv: Readonly<Record<string, string>> | undefined,
  stderr: NodeJS.WritableStream | undefined,
  onMetrics: ((metrics: PiRunMetrics) => void) | undefined,
  watchdogTimeoutMs: number,
  lifecycleReceipt: string | null,
): Promise<string> {
  const [program, ...args] = command;
  if (program === undefined) throw new Error("Pi Reviewer worker command is empty");
  const child = spawn(program, args, {
    cwd: request.cwd,
    env: {
      ...process.env,
      ...appEnv,
      PI_OFFLINE: "1",
      PI_REVIEWER_WORKER: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify(request));
  return await collectChild(child, stderr, onMetrics, watchdogTimeoutMs, lifecycleReceipt);
}

// eslint-disable-next-line max-lines-per-function -- Keep child signals, streams, timers, and cleanup in one owner.
async function collectChild(
  child: ChildProcessWithoutNullStreams,
  stderr: NodeJS.WritableStream | undefined,
  onMetrics: ((metrics: PiRunMetrics) => void) | undefined,
  watchdogTimeoutMs: number,
  lifecycleReceipt: string | null,
): Promise<string> {
  const collector = new PiEventCollector();
  let stderrBytes = 0;
  let failure: Error | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let watchdogTimer: NodeJS.Timeout | undefined;
  let terminationMode: "normal" | "sigterm" | "sigkill" = "normal";
  let shutdownRequested = false;
  const terminate = (message: string): void => {
    failure ??= new Error(message);
    terminationMode = "sigterm";
    terminateProcess(child);
    killTimer ??= setTimeout(() => {
      terminationMode = "sigkill";
      terminateProcess(child, true);
    }, TERMINATION_GRACE_MS);
  };
  watchdogTimer = setTimeout(() => {
    terminate("review worker did not start within 1m");
  }, WORKER_STARTUP_TIMEOUT_MS);
  const onInterrupt = (): void => {
    terminate("review cancelled");
  };
  const onTerminate = (): void => {
    terminate("review terminated");
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  // eslint-disable-next-line complexity -- Process each bounded worker event and its state-dependent cleanup together.
  child.stdout.on("data", (chunk: Buffer) => {
    try {
      const reviewWasStarted = collector.hasReviewStarted();
      collector.feed(chunk);
      if (!reviewWasStarted && collector.hasReviewStarted()) {
        if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
        watchdogTimer = scheduleWorkerWatchdog(child, watchdogTimeoutMs, (error) => {
          failure ??= error;
          terminationMode = "sigkill";
        });
      }
      if (!shutdownRequested && collector.requiresParentTermination()) {
        shutdownRequested = true;
        terminate(collector.shutdownError() ?? "review worker requested parent termination");
      }
      onMetrics?.(collector.metrics());
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      terminate(failure.message);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const remaining = MAX_STDERR_BYTES - stderrBytes;
    if (remaining <= 0) return;
    const output = chunk.subarray(0, remaining);
    stderrBytes += output.length;
    stderr?.write(output);
  });
  return await new Promise<string>((resolve, reject) => {
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code, signal) => {
      void (async () => {
        if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        process.removeListener("SIGINT", onInterrupt);
        process.removeListener("SIGTERM", onTerminate);
        await recordParentTermination(lifecycleReceipt, terminationMode);
        if (failure !== undefined) reject(failure);
        else if (signal !== null) reject(new Error(`Pi terminated by ${signal}`));
        else if (code !== 0) reject(new Error(`Pi exited with status ${String(code)}`));
        else {
          try {
            resolve(collector.finish().finalText);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      })().catch((error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  });
}

export function scheduleWorkerWatchdog(
  child: WorkerProcess,
  timeoutMs: number,
  onTimeout: (error: Error) => void,
  terminate: WorkerTerminator = terminateProcess,
): NodeJS.Timeout {
  return setTimeout(() => {
    onTimeout(new Error("review worker did not exit after its cooperative deadline"));
    terminate(child, true);
  }, timeoutMs);
}

function terminateProcess(child: WorkerProcess, force = false): void {
  const signal = force ? "SIGKILL" : "SIGTERM";
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group is already gone.
    }
  }
  child.kill(signal);
}
