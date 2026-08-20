import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDefaultExecution,
  createReviewSessionManager,
  runReviewWorker,
  workerMessagePayload,
} from "../src/worker.js";
import type { ReviewSubmission } from "../src/submit-review.js";
import type { ReviewWorkerRequest } from "../src/worker-protocol.js";

const cleanup: string[] = [];

const REQUEST = {
  version: 1,
  cwd: "/repo",
  prompt: "review this",
  runtime: { source: "custom", authPath: "/auth.json", modelsPath: "/models.json" },
  configDir: "/config",
  extensionPath: "/review-guard.js",
  systemPrompt: "review",
  provider: "provider",
  model: "model",
  persistSession: false,
  sessionDir: "/sessions",
  sessionReceipt: null,
  lifecycleReceipt: null,
  maxModelRequests: null,
  timeBudgetMs: 10 * 60_000,
  warningRemainingMs: [5 * 60_000, 150_000],
  finalizationGraceMs: 2 * 60_000,
  hardFinalizationGraceMs: 2 * 60_000,
  thinking: "high",
  tools: ["read"],
} satisfies ReviewWorkerRequest;

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("session persistence", () => {
  it("creates a native Pi session and a private receipt by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-reviewer-session-"));
    cleanup.push(root);
    const sessionDir = path.join(root, "sessions");
    const sessionReceipt = path.join(root, "session-receipt.json");
    const manager = createReviewSessionManager({
      ...REQUEST,
      cwd: root,
      persistSession: true,
      sessionDir,
      sessionReceipt,
    });

    expect(manager.isPersisted()).toBe(true);
    const sessionFile = manager.getSessionFile();
    if (sessionFile === undefined) throw new Error("missing test session file");
    expect(JSON.parse(await readFile(sessionReceipt, "utf8"))).toEqual({
      version: 1,
      sessionFile,
    });
    expect((await stat(sessionReceipt)).mode & 0o777).toBe(0o600);
    expect((await stat(sessionFile)).mode & 0o777).toBe(0o600);
    await expect(readFile(sessionFile, "utf8")).resolves.toContain('"type":"session"');
  });

  it("supports explicit in-memory reviews without a receipt", () => {
    const manager = createReviewSessionManager({
      ...REQUEST,
      persistSession: false,
      sessionReceipt: null,
    });
    expect(manager.isPersisted()).toBe(false);
    expect(manager.getSessionFile()).toBeUndefined();
  });
});

function inheritedProviderSource(): string {
  return `
export const version = 1;
const model = {
  id: "reviewer-model",
  name: "Reviewer model",
  api: "openai-completions",
  provider: "reviewer-test",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024
};
export function createProvider() {
  return {
    provider: {
      id: "reviewer-test",
      name: "Reviewer test provider",
      auth: { apiKey: { resolve: async () => ({ auth: { apiKey: "test" }, source: "test" }) } },
      getModels: () => [model],
      stream: () => { throw new Error("unused stream"); },
      streamSimple: () => { throw new Error("unused stream"); }
    }
  };
}
export default function providerExtension() {}
`;
}

const SUBMISSION: ReviewSubmission = {
  findings: [],
  overall_correctness: "patch is correct",
  overall_explanation: "No actionable defects were found.",
  overall_confidence_score: 0.9,
};

// eslint-disable-next-line max-lines-per-function -- Keep worker construction and cleanup cases together.
describe("review worker events", () => {
  it("creates an isolated in-memory Pi execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-reviewer-worker-"));
    cleanup.push(root);
    const configDir = path.join(root, "config");
    const authPath = path.join(root, "auth.json");
    const extensionPath = path.join(root, "empty-extension.ts");
    await mkdir(configDir, { recursive: true });
    await writeFile(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }), {
      mode: 0o600,
    });
    await writeFile(extensionPath, "export default function extension() {}\n");

    const execution = await createDefaultExecution({
      ...REQUEST,
      cwd: root,
      runtime: { source: "custom", authPath, modelsPath: path.join(configDir, "models.json") },
      configDir,
      extensionPath,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    const unsubscribe = execution.subscribe(() => undefined);
    unsubscribe();
    await execution.dispose();
    await execution.flush();
  });

  it("loads one inherited provider without ambient review resources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-reviewer-inherited-worker-"));
    cleanup.push(root);
    const agentDir = path.join(root, "agent");
    const packageDir = path.join(root, "provider-package");
    const configDir = path.join(root, "config");
    const extensionPath = path.join(root, "empty-extension.ts");
    await mkdir(agentDir, { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(extensionPath, "export default function extension() {}\n");
    await writeFile(path.join(packageDir, "index.mjs"), "export default function extension() {}\n");
    await writeFile(
      path.join(packageDir, "unselected.mjs"),
      "throw new Error('ambient extension loaded');\n",
    );
    await writeFile(path.join(packageDir, "provider-module.mjs"), inheritedProviderSource());
    await writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "reviewer-test-provider",
        type: "module",
        pi: { extensions: ["./index.mjs", "./unselected.mjs"] },
        piFactory: {
          providers: [
            {
              version: 1,
              id: "reviewer-test",
              module: "./provider-module.mjs",
              extension: "./index.mjs",
            },
          ],
        },
      }),
    );
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        packages: [
          {
            source: packageDir,
            autoload: false,
            extensions: ["index.mjs"],
          },
        ],
      }),
    );

    const execution = await createDefaultExecution({
      ...REQUEST,
      cwd: root,
      runtime: { source: "pi", agentDir },
      configDir,
      extensionPath,
      provider: "reviewer-test",
      model: "reviewer-model",
    });
    await execution.dispose();
    await execution.flush();
  });

  it("uses a manifest-defined custom model without dynamic provider registration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-reviewer-custom-worker-"));
    cleanup.push(root);
    const configDir = path.join(root, "config");
    const modelsPath = path.join(configDir, "models.json");
    const extensionPath = path.join(root, "empty-extension.ts");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          custom: {
            baseUrl: "https://example.test/v1",
            api: "openai-completions",
            apiKey: "test-key",
            models: [
              {
                id: "review-model",
                name: "Review model",
                reasoning: true,
                input: ["text"],
                contextWindow: 131_072,
                maxTokens: 32_768,
              },
            ],
          },
        },
      }),
    );
    await writeFile(extensionPath, "export default function extension() {}\n");

    const execution = await createDefaultExecution({
      ...REQUEST,
      cwd: root,
      runtime: { source: "custom", authPath: path.join(root, "auth.json"), modelsPath },
      configDir,
      extensionPath,
      provider: "custom",
      model: "review-model",
    });
    await execution.dispose();
    await execution.flush();
  });

  it("rejects missing models and missing authentication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-reviewer-worker-errors-"));
    cleanup.push(root);
    const configDir = path.join(root, "config");
    await mkdir(configDir, { recursive: true });
    const request = {
      ...REQUEST,
      cwd: root,
      runtime: {
        source: "custom",
        authPath: path.join(root, "auth.json"),
        modelsPath: path.join(configDir, "models.json"),
      },
      configDir,
    } satisfies ReviewWorkerRequest;

    await expect(createDefaultExecution(request)).rejects.toThrow(
      "review model not found: provider/model",
    );
    await expect(
      createDefaultExecution({
        ...request,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      }),
    ).rejects.toThrow("no authentication for review provider anthropic");
  });

  it("runs the prompt and always disposes its in-memory execution", async () => {
    const calls: string[] = [];
    await runReviewWorker(REQUEST, () =>
      Promise.resolve({
        subscribe: () => {
          calls.push("subscribe");
          return () => calls.push("unsubscribe");
        },
        prompt: (prompt) => {
          calls.push(`prompt:${prompt}`);
          return Promise.resolve({ forcedExitRequired: false });
        },
        submission: () => SUBMISSION,
        dispose: () => {
          calls.push("dispose");
        },
        flush: () => {
          calls.push("flush");
          return Promise.resolve();
        },
      }),
    );
    expect(calls).toEqual(["subscribe", "prompt:review this", "unsubscribe", "dispose", "flush"]);
  });

  it("rejects a settled review without submit_review", async () => {
    const calls: string[] = [];
    await expect(
      runReviewWorker(REQUEST, () =>
        Promise.resolve({
          subscribe: () => () => calls.push("unsubscribe"),
          prompt: () => Promise.resolve({ forcedExitRequired: false }),
          submission: () => undefined,
          dispose: () => {
            calls.push("dispose");
          },
          flush: () => {
            calls.push("flush");
            return Promise.resolve();
          },
        }),
      ),
    ).rejects.toThrow("without submit_review");
    expect(calls).toEqual(["unsubscribe", "dispose", "flush"]);
  });

  it("cleans up when prompting fails", async () => {
    const calls: string[] = [];
    await expect(
      runReviewWorker(REQUEST, () =>
        Promise.resolve({
          subscribe: () => () => calls.push("unsubscribe"),
          prompt: () => Promise.reject(new Error("failed")),
          submission: () => undefined,
          dispose: () => {
            calls.push("dispose");
          },
          flush: () => {
            calls.push("flush");
            return Promise.resolve();
          },
        }),
      ),
    ).rejects.toThrow("failed");
    expect(calls).toEqual(["unsubscribe", "dispose", "flush"]);
  });

  it("forwards assistant responses without copying tool output", () => {
    const assistant = { role: "assistant", content: [{ type: "text", text: "result" }] };
    expect(workerMessagePayload(assistant)).toEqual({ type: "message_end", message: assistant });
    expect(workerMessagePayload({ role: "toolResult" })).toEqual({ type: "message_end" });
  });
});
