import path from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createPiFactoryRuntime,
  runtimeConfigPaths,
  writePiRuntimeConfig,
  type PiAppDefinition,
} from "@osolmaz/pi-factory";

import { selectAppModel } from "./app.js";
import { regularPiAuthPath } from "./auth-path.js";
import {
  canonicalModelsStorePath,
  registerHuggingFaceOAuthProvider,
} from "./huggingface-provider.js";
import type { ModelSelection } from "./types.js";

export async function listReviewerModels(
  app: PiAppDefinition,
  search?: string,
  authPath = regularPiAuthPath(),
  selection?: ModelSelection,
): Promise<readonly string[]> {
  if (selection !== undefined) {
    const selectedApp = selectAppModel(app, selection);
    const config = runtimeConfigPaths(selectedApp);
    const runtime = await createPiFactoryRuntime({
      app: selectedApp,
      cwd: process.cwd(),
      agentDir: path.dirname(authPath),
      appAgentDir: config.configDir,
      providerId: selection.provider,
      modelId: selection.model,
      prepareModelRuntime: registerHuggingFaceOAuthProvider,
    });
    try {
      return filterModels(await runtime.modelRuntime.getAvailable(), search);
    } finally {
      await runtime.close();
    }
  }
  const config = await writePiRuntimeConfig(app);
  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath: config.modelsPath,
    modelsStorePath: canonicalModelsStorePath(authPath),
    allowModelNetwork: false,
  });
  await registerHuggingFaceOAuthProvider(runtime);
  return filterModels(await runtime.getAvailable(), search);
}

function filterModels(
  models: readonly { readonly provider: string; readonly id: string }[],
  search: string | undefined,
): readonly string[] {
  const query = search?.toLowerCase();
  return models
    .map((model) => `${model.provider}/${model.id}`)
    .filter((model) => query === undefined || model.toLowerCase().includes(query))
    .sort((left, right) => left.localeCompare(right));
}
