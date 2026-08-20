import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { LifecycleEvidence } from "../src/lifecycle-receipt.js";
import { runThreePhaseReview } from "../src/review-controller.js";
import { ReviewLifecycle } from "../src/review-lifecycle.js";
import { createSubmitReviewTool, ReviewSubmissionGate } from "../src/submit-review.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function controlledSession(): Promise<{
  session: AgentSession;
  faux: ReturnType<typeof fauxProvider>;
  contexts: string[];
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-reviewer-agent-session-"));
  cleanup.push(root);
  const faux = fauxProvider({
    api: "openai-completions",
    provider: `faux-${path.basename(root)}`,
    models: [{ id: "review-model", reasoning: true, contextWindow: 32_768, maxTokens: 8_192 }],
    tokensPerSecond: 200,
    tokenSize: { min: 1, max: 1 },
  });
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: path.join(root, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt: "controlled test prompt",
  });
  await loader.reload();
  const contexts: string[] = [];
  faux.setResponses([
    (context) => {
      contexts.push(JSON.stringify(context.messages));
      return fauxAssistantMessage(fauxText("x".repeat(2_000)));
    },
    (context) => {
      contexts.push(JSON.stringify(context.messages));
      return fauxAssistantMessage("continued");
    },
  ]);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: path.join(root, "agent"),
    modelRuntime,
    model: faux.getModel(),
    thinkingLevel: "high",
    noTools: "all",
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(root),
  });
  return { session, faux, contexts };
}

async function waitForFirstDelta(session: AgentSession): Promise<void> {
  await new Promise<void>((resolve) => {
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        unsubscribe();
        resolve();
      }
    });
  });
}

describe("real AgentSession queue and abort behavior", () => {
  it("continues a queued steer after abort and settles only after the continuation", async () => {
    const { session, faux, contexts } = await controlledSession();
    try {
      const prompt = session.prompt("explore");
      await waitForFirstDelta(session);
      await session.steer("QUEUED_CONTINUATION_TRAP");
      expect(session.pendingMessageCount).toBe(1);
      await session.abort();
      await prompt;
      await session.waitForIdle();
      expect(session.isIdle).toBe(true);
      expect(faux.state.callCount).toBe(2);
      expect(contexts[1]).toContain("QUEUED_CONTINUATION_TRAP");
    } finally {
      session.dispose();
    }
  });

  it("clears the queue before abort, confirms idle, and permits a clean later prompt", async () => {
    const { session, faux, contexts } = await controlledSession();
    try {
      const prompt = session.prompt("explore");
      await waitForFirstDelta(session);
      await session.steer("CLEARED_CONTINUATION_TRAP");
      const cleared = session.clearQueue();
      expect(cleared.steering).toEqual(["CLEARED_CONTINUATION_TRAP"]);
      expect(session.pendingMessageCount).toBe(0);
      await session.abort();
      await prompt;
      await session.waitForIdle();
      expect(session.isIdle).toBe(true);
      expect(faux.state.callCount).toBe(1);

      await session.prompt("normal continuation");
      await session.waitForIdle();
      expect(faux.state.callCount).toBe(2);
      expect(contexts[1]).toContain("normal continuation");
      expect(contexts[1]).not.toContain("CLEARED_CONTINUATION_TRAP");
    } finally {
      session.dispose();
    }
  }, 20_000);

  it("uses the normal AgentSession loop for soft finalization with full tools and unchanged thinking", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-reviewer-soft-session-"));
    cleanup.push(root);
    const faux = fauxProvider({
      api: "openai-completions",
      provider: `soft-${path.basename(root)}`,
      models: [{ id: "review-model", reasoning: true, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const eventBus = createEventBus();
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: path.join(root, "agent"),
      settingsManager,
      eventBus,
      additionalExtensionPaths: [
        path.resolve(process.cwd(), "reviewer/extensions/review-guard.ts"),
      ],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: "stable soft system prompt",
    });
    await loader.reload();
    const gate = new ReviewSubmissionGate(root);
    const sessionManager = SessionManager.inMemory(root);
    const requests: { tools: string[]; reasoning: unknown; finalUser: unknown }[] = [];
    faux.setResponses([
      (context, options) => {
        requests.push({
          tools: context.tools?.map((tool) => tool.name) ?? [],
          reasoning: options?.reasoning,
          finalUser: context.messages.at(-1),
        });
        return fauxAssistantMessage("exploration ended without submission");
      },
      (context, options) => {
        requests.push({
          tools: context.tools?.map((tool) => tool.name) ?? [],
          reasoning: options?.reasoning,
          finalUser: context.messages.at(-1),
        });
        return fauxAssistantMessage(
          {
            type: "toolCall",
            id: "submit-soft",
            name: "submit_review",
            arguments: {
              findings: [],
              overall_correctness: "patch is correct",
              overall_explanation: "No defect found.",
              overall_confidence_score: 0.9,
            },
          },
          { stopReason: "toolUse" },
        );
      },
    ]);
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: path.join(root, "agent"),
      modelRuntime,
      model: faux.getModel(),
      thinkingLevel: "high",
      tools: ["read", "submit_review"],
      customTools: [createSubmitReviewTool(gate)],
      resourceLoader: loader,
      settingsManager,
      sessionManager,
    });
    const lifecycle = new ReviewLifecycle();
    const evidence = new LifecycleEvidence(lifecycle, null);
    const initialTools = session.getActiveToolNames();
    try {
      const result = await runThreePhaseReview(
        {
          session,
          sessionManager,
          eventBus,
          policy: {
            timeBudgetMs: 60_000,
            warningRemainingMs: [],
            finalizationGraceMs: 60_000,
            hardFinalizationGraceMs: 60_000,
          },
          maxModelRequests: null,
          gate,
          lifecycle,
          evidence,
          recordStablePrefix: (_preSoftLeafId, finalizationPrompt) => {
            evidence.setStructuralHashes({
              systemPrompt: "system-hash",
              contextPrefix: "context-hash",
              finalizationPrompt: `hash:${String(finalizationPrompt.length)}`,
              orderedTools: "tools-hash",
            });
          },
          hardFinalize: () => Promise.reject(new Error("hard finalization must not run")),
        },
        "review",
      );
      expect(result).toEqual({ forcedExitRequired: false });
      expect(gate.acceptedCallCount).toBe(1);
      expect(faux.state.callCount).toBe(2);
      expect(session.thinkingLevel).toBe("high");
      expect(session.getActiveToolNames()).toEqual(initialTools);
      expect(requests[1]?.tools).toEqual(requests[0]?.tools);
      expect(requests[1]?.tools).toContain("read");
      expect(requests[1]?.tools).toContain("submit_review");
      expect(requests[1]?.reasoning).toBe("high");
      expect(JSON.stringify(requests[1]?.finalUser)).toContain("submit_review");
      expect(evidence.snapshot().structuralHashes).toMatchObject({
        systemPrompt: "system-hash",
        contextPrefix: "context-hash",
        orderedTools: "tools-hash",
      });
      expect(lifecycle.transitions.map((entry) => entry.to)).toEqual([
        "exploring",
        "quiescing_before_soft",
        "soft_finalizing",
        "accepted",
        "shutdown_ready",
      ]);
    } finally {
      session.dispose();
    }
  });
});
