import type { EventBus, ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { executeShellCommand, validateCheckoutPath, validateShellCommand } from "./shell-policy.ts";

const ACTIVE_TOOLS = new Set(["read", "grep", "find", "ls", "review_shell", "submit_review"]);
export const REVIEW_PHASE_EVENT = "pi-reviewer:phase";

export type ReviewGuardPhase = "exploring" | "soft_finalizing" | "hard_finalizing";

export default function reviewGuard(pi: ExtensionAPI): void {
  const reviewPhase = listenForReviewPhase(pi.events);
  pi.on("session_shutdown", () => {
    reviewPhase.dispose();
  });

  pi.registerTool({
    name: "review_shell",
    label: "Review shell",
    description: "Run one guarded read-only repository inspection command",
    parameters: Type.Object({
      command: Type.String({ description: "One read-only command without shell operators" }),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const command = await validateShellCommand(params.command, ctx.cwd);
      const result = await executeShellCommand(command, ctx.cwd, signal);
      return {
        content: [
          {
            type: "text",
            text: result.output === "" ? `(exit ${String(result.exitCode)})` : result.output,
          },
        ],
        details: result,
      };
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    const unavailable = toolUnavailableReason(event.toolName, reviewPhase.current());
    if (unavailable !== undefined) return { block: true, reason: unavailable };
    const inputPath = toolPath(event);
    if (inputPath === undefined) return;
    try {
      await validateCheckoutPath(inputPath, ctx.cwd);
      return undefined;
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  });
}

export function listenForReviewPhase(events: EventBus): {
  readonly current: () => ReviewGuardPhase;
  readonly dispose: () => void;
} {
  let phase: ReviewGuardPhase = "exploring";
  const dispose = events.on(REVIEW_PHASE_EVENT, (value) => {
    if (isReviewGuardPhase(value)) phase = value;
  });
  return { current: () => phase, dispose };
}

export function toolUnavailableReason(
  toolName: string,
  phase: ReviewGuardPhase,
): string | undefined {
  if (!ACTIVE_TOOLS.has(toolName)) {
    return `Tool ${toolName} is unavailable in read-only review mode`;
  }
  if (phase !== "exploring" && toolName !== "submit_review") {
    return `Tool ${toolName} is unavailable during review finalization`;
  }
  return undefined;
}

function isReviewGuardPhase(value: unknown): value is ReviewGuardPhase {
  return value === "exploring" || value === "soft_finalizing" || value === "hard_finalizing";
}

function toolPath(event: ToolCallEvent): string | undefined {
  if (isToolCallEventType("read", event)) return event.input.path;
  if (isToolCallEventType("grep", event)) return event.input.path;
  if (isToolCallEventType("find", event)) return event.input.path;
  if (isToolCallEventType("ls", event)) return event.input.path;
  return undefined;
}
