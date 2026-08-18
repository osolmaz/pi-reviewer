#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadReviewerApp } from "./app.js";
import { parseArgs, parseModel, reviewUsage } from "./args.js";
import { loginReviewerApp } from "./auth.js";
import { loadConfig, resetConfig, setConfigModel, setConfigThinking } from "./config.js";
import { resolveTarget } from "./git-target.js";
import { loadCustomModelManifest } from "./model-manifest.js";
import { listReviewerModels } from "./models.js";
import type { PiRunMetrics } from "./pi-events.js";
import { renderReview, renderReviewJson } from "./render.js";
import { runReview, type RunReviewInput } from "./runner.js";
import { terminalText } from "./terminal-text.js";
import type { ModelSelection, ReviewRequest, ThinkingLevel, UserConfig } from "./types.js";
import { packageVersion } from "./version.js";

export async function main(args: readonly string[]): Promise<number> {
  const command = parseArgs(args);
  if (command.kind === "review") return await runReviewCommand(command.request);
  if (command.kind === "login") return await runLogin(command.provider);
  if (command.kind === "models") return await runModels(command.search);
  return await runUtilityCommand(command);
}

type UtilityCommand = Exclude<
  ReturnType<typeof parseArgs>,
  { kind: "review" | "login" | "models" }
>;
type ConfigCommand = Exclude<UtilityCommand, { kind: "help" | "version" }>;

async function runUtilityCommand(command: UtilityCommand): Promise<number> {
  if (command.kind === "help") {
    process.stdout.write(help());
    return 0;
  }
  if (command.kind === "version") {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  return await runConfigCommand(command);
}

async function runConfigCommand(command: ConfigCommand): Promise<number> {
  switch (command.kind) {
    case "config-show":
      process.stdout.write(`${JSON.stringify(await loadConfig(), null, 2)}\n`);
      return 0;
    case "config-reset":
      await resetConfig();
      process.stdout.write("Pi Reviewer defaults reset.\n");
      return 0;
    case "config-set-model":
      process.stdout.write(`${JSON.stringify(await setConfigModel(command.model), null, 2)}\n`);
      return 0;
    case "config-set-thinking":
      process.stdout.write(
        `${JSON.stringify(await setConfigThinking(command.thinking), null, 2)}\n`,
      );
      return 0;
  }
}

async function runLogin(provider: string | undefined): Promise<number> {
  await loginReviewerApp(await loadReviewerApp(), provider);
  return 0;
}

async function runModels(search: string | undefined): Promise<number> {
  const models = await listReviewerModels(await loadReviewerApp(), search);
  process.stdout.write(
    models.length === 0 ? "No matching authenticated models.\n" : `${models.join("\n")}\n`,
  );
  return 0;
}

async function runReviewCommand(request: ReviewRequest): Promise<number> {
  const config = await loadConfig();
  const selection = resolveSelection(request.model, request.thinking, config);
  const modelManifest =
    request.modelManifest === undefined
      ? undefined
      : await loadCustomModelManifest(request.modelManifest, selection);
  const target = await resolveTarget(request.target, request.cwd);
  const app = await loadReviewerApp();
  const metricsFile = request.metricsFile;
  process.stderr.write(formatReviewProgress(target.hint, selection));
  const output = await runReview({
    app,
    selection,
    ...(modelManifest === undefined ? {} : { modelManifest }),
    ...(request.maxModelRequests === undefined
      ? {}
      : { maxModelRequests: request.maxModelRequests }),
    ...budgetRunOptions(request),
    ...sessionRunOptions(request),
    cwd: target.cwd,
    prompt: target.prompt,
    stderr: process.stderr,
    ...(metricsFile === undefined
      ? {}
      : {
          onMetrics: (metrics: PiRunMetrics) => {
            writeMetrics(metricsFile, metrics);
          },
        }),
  });
  process.stdout.write(request.format === "json" ? renderReviewJson(output) : renderReview(output));
  return 0;
}

function budgetRunOptions(
  request: ReviewRequest,
): Partial<Pick<RunReviewInput, "timeBudgetMs" | "timeWarnings" | "finalizationGraceMs">> {
  return {
    ...(request.timeBudgetMs === undefined ? {} : { timeBudgetMs: request.timeBudgetMs }),
    ...(request.timeWarnings === undefined ? {} : { timeWarnings: request.timeWarnings }),
    ...(request.finalizationGraceMs === undefined
      ? {}
      : { finalizationGraceMs: request.finalizationGraceMs }),
  };
}

function sessionRunOptions(
  request: ReviewRequest,
): Partial<Pick<RunReviewInput, "persistSession" | "sessionDir" | "sessionReceipt">> {
  return {
    ...(request.persistSession === undefined ? {} : { persistSession: request.persistSession }),
    ...(request.sessionDir === undefined ? {} : { sessionDir: request.sessionDir }),
    ...(request.sessionReceipt === undefined ? {} : { sessionReceipt: request.sessionReceipt }),
  };
}

function writeMetrics(path: string, metrics: PiRunMetrics): void {
  writeFileSync(path, `${JSON.stringify(metrics)}\n`, { mode: 0o600 });
}

export function formatReviewProgress(hint: string, selection: ModelSelection): string {
  return terminalText(
    `Reviewing ${hint} with ${selection.provider}/${selection.model}:${selection.thinking}\n`,
  );
}

export function resolveSelection(
  modelOverride: string | undefined,
  thinkingOverride: ThinkingLevel | undefined,
  config: UserConfig,
): ModelSelection {
  const configuredModel = modelOverride ?? config.model;
  if (configuredModel === undefined) {
    throw new Error(
      "No review model configured. Run `pi-reviewer config set model provider/model` or pass --model provider/model.",
    );
  }
  const model = parseModel(configuredModel);
  return {
    ...model,
    thinking: thinkingOverride ?? config.thinking ?? "high",
  };
}

function help(): string {
  return `${[
    "pi-reviewer - isolated read-only code review with P0-P3 findings",
    "",
    reviewUsage(),
    "",
    "commands:",
    "  pi-reviewer config set model PROVIDER/MODEL",
    "  pi-reviewer config set thinking LEVEL",
    "  pi-reviewer config show",
    "  pi-reviewer config reset",
    "  pi-reviewer login [provider]",
    "  pi-reviewer models [search]",
    "",
  ].join("\n")}\n`;
}

export async function runCli(args: readonly string[]): Promise<void> {
  try {
    process.exitCode = await main(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${terminalText(message)}\n`);
    process.exitCode = message === "review cancelled" ? 130 : 1;
  }
}

async function isMainModule(): Promise<boolean> {
  const script = process.argv[1];
  if (script === undefined) return false;
  const [modulePath, scriptPath] = await Promise.all([
    realpath(fileURLToPath(import.meta.url)),
    realpath(script).catch(() => script),
  ]);
  return modulePath === scriptPath;
}

if (await isMainModule()) await runCli(process.argv.slice(2));
