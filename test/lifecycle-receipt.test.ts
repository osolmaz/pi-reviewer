import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import {
  finalizeSessionReceipt,
  LifecycleEvidence,
  recordParentTermination,
  structuralHash,
} from "../src/lifecycle-receipt.js";
import { ReviewLifecycle } from "../src/review-lifecycle.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("lifecycle evidence", () => {
  it("writes a private complete redacted receipt with ordered timestamps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-reviewer-receipt-"));
    cleanup.push(root);
    const receiptPath = path.join(root, "lifecycle.json");
    let time = 0;
    const lifecycle = new ReviewLifecycle(() => new Date((time += 1)));
    lifecycle.transition("quiescing_before_soft", "deadline");
    lifecycle.record({ kind: "queue_cleared", steeringCount: 1, followUpCount: 0 });
    lifecycle.record({ kind: "abort_requested" });
    lifecycle.record({ kind: "abort_settled" });
    lifecycle.record({ kind: "idle_confirmed" });
    lifecycle.transition("soft_finalizing", "idle");
    lifecycle.transition("accepted", "soft_submission");
    lifecycle.transition("shutdown_ready", "accepted_complete");
    const evidence = new LifecycleEvidence(lifecycle, receiptPath);
    evidence.setBranches("pre-soft", "soft-leaf");
    evidence.setStructuralHashes({
      systemPrompt: structuralHash("UNIQUE_SYSTEM_MARKER"),
      contextPrefix: structuralHash("UNIQUE_CONTEXT_MARKER"),
      finalizationPrompt: structuralHash("UNIQUE_FINAL_MARKER"),
      orderedTools: structuralHash(["read", "submit_review"]),
    });
    evidence.recordAcceptedSubmission();
    evidence.recordSubmissionNormalization({
      titleTruncationCount: 2,
      priorityInferenceCount: 1,
    });
    evidence.markComplete(false);
    await evidence.flush();

    const text = await readFile(receiptPath, "utf8");
    const receipt = JSON.parse(text) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      version: 1,
      branches: { preSoftLeafId: "pre-soft", softBranchLeafId: "soft-leaf" },
      submission: {
        acceptedCallCount: 1,
        normalization: { titleTruncationCount: 2, priorityInferenceCount: 1 },
      },
      terminal: {
        complete: true,
        forcedExitRequired: false,
        parentTerminationMode: "pending",
      },
    });
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
    expect(text).not.toContain("UNIQUE_SYSTEM_MARKER");
    expect(text).not.toContain("UNIQUE_CONTEXT_MARKER");
    expect(text).not.toContain("UNIQUE_FINAL_MARKER");
    expect(text).not.toMatch(/authorization|bearer|api[_-]?key/iu);
    const transitions = receipt["transitions"] as { timestamp: string }[];
    expect(
      transitions.slice(1).every((entry, index) => {
        const previous = transitions[index];
        return previous !== undefined && previous.timestamp <= entry.timestamp;
      }),
    ).toBe(true);
  });

  it("records parent normal, SIGTERM, and SIGKILL modes without changing evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-reviewer-parent-"));
    cleanup.push(root);
    const receiptPath = path.join(root, "lifecycle.json");
    const lifecycle = new ReviewLifecycle();
    lifecycle.transition("accepted", "submission");
    lifecycle.transition("shutdown_ready", "done");
    const evidence = new LifecycleEvidence(lifecycle, receiptPath);
    evidence.markComplete(false);
    await evidence.flush();
    for (const mode of ["normal", "sigterm", "sigkill"] as const) {
      await recordParentTermination(receiptPath, mode);
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
        terminal: { parentTerminationMode: string };
      };
      expect(receipt.terminal.parentTerminationMode).toBe(mode);
    }
  });
});

describe("native session receipt", () => {
  it("records mode, checksum, byte count, and entry count", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-reviewer-session-proof-"));
    cleanup.push(root);
    const sessionFile = path.join(root, "session.jsonl");
    await writeFile(sessionFile, "", { mode: 0o600 });
    const manager = SessionManager.open(sessionFile, root, root);
    manager.appendMessage({ role: "user", content: "review", timestamp: 1 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai-completions",
      provider: "custom",
      model: "review-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    const receiptPath = path.join(root, "session-receipt.json");
    const receipt = await finalizeSessionReceipt(receiptPath, sessionFile);
    const bytes = await readFile(sessionFile);
    expect(receipt).toEqual({
      version: 1,
      sessionFile,
      mode: "0600",
      byteCount: bytes.byteLength,
      entryCount: 2,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
  });
});
