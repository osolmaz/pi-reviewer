import type { EventBus, ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { executeShellCommand, validateCheckoutPath, validateShellCommand } from "./shell-policy.ts";

const ACTIVE_TOOLS = new Set(["read", "grep", "find", "ls", "review_shell", "submit_review"]);
export const REVIEW_FINALIZATION_EVENT = "pi-reviewer:finalization";

export default function reviewGuard(pi: ExtensionAPI): void {
  const finalization = listenForReviewFinalization(pi.events);
  pi.on("session_shutdown", () => {
    finalization.dispose();
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
    const unavailable = toolUnavailableReason(event.toolName, finalization.isActive());
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

export function listenForReviewFinalization(events: EventBus): {
  readonly isActive: () => boolean;
  readonly dispose: () => void;
} {
  let active = false;
  const dispose = events.on(REVIEW_FINALIZATION_EVENT, () => {
    active = true;
  });
  return { isActive: () => active, dispose };
}

export function toolUnavailableReason(toolName: string, finalizing: boolean): string | undefined {
  if (!ACTIVE_TOOLS.has(toolName)) {
    return `Tool ${toolName} is unavailable in read-only review mode`;
  }
  if (finalizing && toolName !== "submit_review") {
    return `Tool ${toolName} is unavailable during review finalization`;
  }
  return undefined;
}

function toolPath(event: ToolCallEvent): string | undefined {
  if (isToolCallEventType("read", event)) return event.input.path;
  if (isToolCallEventType("grep", event)) return event.input.path;
  if (isToolCallEventType("find", event)) return event.input.path;
  if (isToolCallEventType("ls", event)) return event.input.path;
  return undefined;
}
