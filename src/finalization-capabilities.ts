import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type NamedSubmitReviewChoice = {
  readonly type: "function";
  readonly function: { readonly name: "submit_review" };
};

const NAMED_TOOL_CHOICE_APIS = new Set(["openai-completions"]);

export function requireForcedSubmissionCapability(
  modelRuntime: Pick<ModelRuntime, "getProvider">,
  model: Model<Api>,
): NamedSubmitReviewChoice {
  const provider = modelRuntime.getProvider(model.provider);
  if (provider === undefined || typeof provider.streamSimple !== "function") {
    throw new Error(`review provider ${model.provider} has no public streamSimple adapter`);
  }
  if (!NAMED_TOOL_CHOICE_APIS.has(model.api)) {
    throw new Error(
      `review route ${model.provider}/${model.id} (${model.api}) cannot serialize named forced tool choice through streamSimple`,
    );
  }
  return { type: "function", function: { name: "submit_review" } };
}
