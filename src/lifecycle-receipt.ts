import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

import type {
  LifecycleOperationalEvent,
  LifecycleTransition,
  ReviewLifecycle,
} from "./review-lifecycle.js";

export type StructuralHashes = {
  readonly systemPrompt: string;
  readonly contextPrefix: string;
  readonly finalizationPrompt: string;
  readonly orderedTools: string;
};

export type HardRequestEvidence = {
  readonly dispatchedAt: string;
  readonly responseHeaderAt?: string;
  readonly firstStreamAt?: string;
  readonly lastStreamAt?: string;
  readonly settledAt?: string;
  readonly provider: string;
  readonly model: string;
  readonly responseModel?: string;
  readonly api: string;
  readonly reasoning: "off";
  readonly toolChoice: { readonly type: "function"; readonly function: { readonly name: string } };
  readonly maxRetries: 0;
  readonly maxTokens: number;
  readonly deadlineMs: number;
  readonly streamEventCounts: Readonly<Record<string, number>>;
  readonly streamedCharacters: number;
  readonly usage?: Usage;
};

export type LifecycleReceipt = {
  readonly version: 1;
  readonly transitions: readonly LifecycleTransition[];
  readonly events: readonly LifecycleOperationalEvent[];
  readonly branches: {
    readonly preSoftLeafId?: string;
    readonly softBranchLeafId?: string;
  };
  readonly structuralHashes?: StructuralHashes;
  readonly hardRequest?: HardRequestEvidence;
  readonly responses: readonly {
    readonly phase: string;
    readonly timestamp: string;
    readonly provider: string;
    readonly model: string;
    readonly responseModel?: string;
    readonly api: string;
    readonly stopReason: string;
    readonly usage: Usage;
  }[];
  readonly submission: {
    readonly acceptedCallCount: number;
    readonly acceptedAt?: string;
  };
  readonly terminal: {
    readonly complete: boolean;
    readonly forcedExitRequired: boolean;
    readonly parentTerminationMode: "pending" | "normal" | "sigterm" | "sigkill";
  };
};

export class LifecycleEvidence {
  private preSoftLeafId: string | undefined;
  private softBranchLeafId: string | undefined;
  private hashes: StructuralHashes | undefined;
  private hardRequest: HardRequestEvidence | undefined;
  private readonly responses: LifecycleReceipt["responses"][number][] = [];
  private acceptedCallCount = 0;
  private acceptedAt: string | undefined;
  private forcedExitRequired = false;
  private complete = false;

  constructor(
    readonly lifecycle: ReviewLifecycle,
    readonly receiptPath: string | null,
  ) {}

  setBranches(preSoftLeafId: string | undefined, softBranchLeafId?: string): void {
    this.preSoftLeafId = preSoftLeafId;
    this.softBranchLeafId = softBranchLeafId;
  }

  setStructuralHashes(hashes: StructuralHashes): void {
    this.hashes = hashes;
  }

  setHardRequest(evidence: HardRequestEvidence): void {
    this.hardRequest = evidence;
  }

  recordAssistant(message: AssistantMessage): void {
    this.responses.push({
      phase: this.lifecycle.state,
      timestamp: new Date(message.timestamp).toISOString(),
      provider: message.provider,
      model: message.model,
      ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
      api: message.api,
      stopReason: message.stopReason,
      usage: message.usage,
    });
  }

  recordAcceptedSubmission(): void {
    this.acceptedCallCount += 1;
    this.acceptedAt ??= new Date().toISOString();
  }

  markComplete(forcedExitRequired: boolean): void {
    this.complete = true;
    this.forcedExitRequired = forcedExitRequired;
  }

  snapshot(): LifecycleReceipt {
    return {
      version: 1,
      transitions: this.lifecycle.transitions,
      events: this.lifecycle.events,
      branches: {
        ...(this.preSoftLeafId === undefined ? {} : { preSoftLeafId: this.preSoftLeafId }),
        ...(this.softBranchLeafId === undefined ? {} : { softBranchLeafId: this.softBranchLeafId }),
      },
      ...(this.hashes === undefined ? {} : { structuralHashes: this.hashes }),
      ...(this.hardRequest === undefined ? {} : { hardRequest: this.hardRequest }),
      responses: [...this.responses],
      submission: {
        acceptedCallCount: this.acceptedCallCount,
        ...(this.acceptedAt === undefined ? {} : { acceptedAt: this.acceptedAt }),
      },
      terminal: {
        complete: this.complete,
        forcedExitRequired: this.forcedExitRequired,
        parentTerminationMode: "pending",
      },
    };
  }

  async flush(): Promise<void> {
    if (this.receiptPath === null) return;
    this.lifecycle.record({ kind: "receipt_flushed" });
    await writePrivateJson(this.receiptPath, this.snapshot());
  }
}

export type SessionReceipt = {
  readonly version: 1;
  readonly sessionFile: string;
  readonly mode: "0600";
  readonly byteCount: number;
  readonly entryCount: number;
  readonly sha256: string;
};

export async function finalizeSessionReceipt(
  receiptPath: string | null,
  sessionFile: string | undefined,
): Promise<SessionReceipt | undefined> {
  if (receiptPath === null || sessionFile === undefined) return undefined;
  const bytes = await readFile(sessionFile);
  const fileStat = await stat(sessionFile);
  const lines = bytes
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  if ((fileStat.mode & 0o777) !== 0o600) {
    throw new Error("native Pi session file must use mode 0600");
  }
  const receipt: SessionReceipt = {
    version: 1,
    sessionFile,
    mode: "0600",
    byteCount: bytes.byteLength,
    entryCount: Math.max(0, lines.length - 1),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await writePrivateJson(receiptPath, receipt);
  return receipt;
}

export async function recordParentTermination(
  receiptPath: string | null,
  mode: LifecycleReceipt["terminal"]["parentTerminationMode"],
): Promise<void> {
  if (receiptPath === null) return;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch {
    return;
  }
  if (!isRecord(value) || value["version"] !== 1 || !isRecord(value["terminal"])) return;
  const receipt = value as unknown as LifecycleReceipt;
  await writePrivateJson(receiptPath, {
    ...receipt,
    terminal: { ...receipt.terminal, parentTerminationMode: mode },
  });
}

export function structuralHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function assistantUsageEvidence(
  message: AssistantMessage,
): Pick<HardRequestEvidence, "provider" | "model" | "responseModel" | "api" | "usage"> {
  return {
    provider: message.provider,
    model: message.model,
    ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
    api: message.api,
    usage: message.usage,
  };
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  const serialized: unknown = JSON.stringify(value);
  return typeof serialized === "string" ? serialized : "null";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
