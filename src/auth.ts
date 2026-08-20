import { createInterface } from "node:readline/promises";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  resolveInheritance,
  writePiRuntimeConfig,
  type PiAppDefinition,
} from "@osolmaz/pi-factory";

import { selectAppModel } from "./app.js";
import { regularPiAgentDir, regularPiAuthPath } from "./auth-path.js";
import {
  canonicalModelsStorePath,
  registerHuggingFaceOAuthProvider,
} from "./huggingface-provider.js";
import { terminalText } from "./terminal-text.js";

type AuthType = Parameters<ModelRuntime["login"]>[1];
type AuthInteraction = Parameters<ModelRuntime["login"]>[2];
type AuthPrompt = Parameters<AuthInteraction["prompt"]>[0];
type AuthEvent = Parameters<AuthInteraction["notify"]>[0];

type LoginProvider = {
  readonly id: string;
  readonly name: string;
  readonly auth: {
    readonly oauth?: unknown;
    readonly apiKey?: { readonly login?: unknown };
  };
};

type LoginRuntime = {
  getProviders(): readonly LoginProvider[];
  login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<unknown>;
};

type RuntimePaths = {
  readonly authPath: string;
  readonly modelsPath: string;
};

type RuntimeFactory = (paths: RuntimePaths) => Promise<LoginRuntime>;
type ProviderAuthenticationOwner = (app: PiAppDefinition, providerId: string) => Promise<boolean>;

export type AuthTerminal = {
  question(message: string, signal?: AbortSignal): Promise<string>;
  secret(message: string, signal?: AbortSignal): Promise<string>;
  write(message: string): void;
};

export async function loginReviewerApp(
  app: PiAppDefinition,
  requestedProvider?: string,
  terminal: AuthTerminal = createAuthTerminal(),
  createRuntime: RuntimeFactory = defaultRuntimeFactory,
  providerOwnsAuthentication: ProviderAuthenticationOwner = inheritedProviderOwnsAuthentication,
): Promise<void> {
  if (
    requestedProvider !== undefined &&
    (await providerOwnsAuthentication(app, requestedProvider))
  ) {
    throw new Error(
      `Authentication for ${requestedProvider} is managed by the selected provider in the main Pi profile.`,
    );
  }
  const config = await writePiRuntimeConfig(app);
  const runtime = await createRuntime({
    authPath: regularPiAuthPath(),
    modelsPath: config.modelsPath,
  });
  const providers = loginProviders(runtime.getProviders());
  const provider = await selectProvider(providers, requestedProvider, terminal);
  if (requestedProvider === undefined && (await providerOwnsAuthentication(app, provider.id))) {
    throw new Error(
      `Authentication for ${provider.name} is managed by the selected provider in the main Pi profile.`,
    );
  }
  const method = await selectAuthType(provider, terminal);
  await runtime.login(provider.id, method, createAuthInteraction(terminal));
  terminal.write(terminalText(`Authenticated ${provider.name} in the regular Pi profile.\n`));
}

function loginProviders(providers: readonly LoginProvider[]): readonly LoginProvider[] {
  return providers
    .filter(
      (provider) => provider.auth.oauth !== undefined || provider.auth.apiKey?.login !== undefined,
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function selectProvider(
  providers: readonly LoginProvider[],
  requested: string | undefined,
  terminal: AuthTerminal,
): Promise<LoginProvider> {
  if (requested !== undefined) {
    const provider = providers.find((entry) => entry.id === requested);
    if (provider === undefined) throw new Error(`Provider ${requested} has no interactive login`);
    return provider;
  }
  if (providers.length === 0) throw new Error("No providers support interactive login");
  const selected = await select(
    "Choose a provider",
    providers.map((provider) => ({ id: provider.id, label: `${provider.name} (${provider.id})` })),
    terminal,
  );
  const provider = providers.find((entry) => entry.id === selected);
  if (provider === undefined) throw new Error("Invalid provider selection");
  return provider;
}

async function selectAuthType(provider: LoginProvider, terminal: AuthTerminal): Promise<AuthType> {
  const methods: { readonly id: AuthType; readonly label: string }[] = [];
  if (provider.auth.oauth !== undefined) methods.push({ id: "oauth", label: "Account sign-in" });
  if (provider.auth.apiKey?.login !== undefined) methods.push({ id: "api_key", label: "API key" });
  const only = methods[0];
  if (methods.length === 1 && only !== undefined) return only.id;
  const selected = await select("Choose a login method", methods, terminal);
  return selected === "oauth" ? "oauth" : "api_key";
}

function createAuthInteraction(terminal: AuthTerminal): AuthInteraction {
  return {
    prompt: async (prompt) => await answerPrompt(prompt, terminal),
    notify: (event) => {
      terminal.write(terminalText(formatAuthEvent(event)));
    },
  };
}

async function answerPrompt(prompt: AuthPrompt, terminal: AuthTerminal): Promise<string> {
  if (prompt.type === "select")
    return await select(prompt.message, prompt.options, terminal, prompt.signal);
  const suffix = prompt.placeholder === undefined ? "" : ` (${prompt.placeholder})`;
  const message = terminalText(`${prompt.message}${suffix}: `);
  if (prompt.type === "secret") return await terminal.secret(message, prompt.signal);
  return await terminal.question(message, prompt.signal);
}

async function select<T extends string>(
  message: string,
  options: readonly { readonly id: T; readonly label: string; readonly description?: string }[],
  terminal: AuthTerminal,
  signal?: AbortSignal,
): Promise<T> {
  if (options.length === 0) throw new Error(`${message}: no choices available`);
  terminal.write(terminalText(`${message}:\n`));
  options.forEach((option, index) => {
    const description = option.description === undefined ? "" : ` — ${option.description}`;
    terminal.write(terminalText(`  ${String(index + 1)}. ${option.label}${description}\n`));
  });
  const answer = await terminal.question(`Enter number (1-${String(options.length)}): `, signal);
  const index = Number.parseInt(answer, 10) - 1;
  const selected = options[index];
  if (selected === undefined) throw new Error("Invalid selection");
  return selected.id;
}

function formatAuthEvent(event: AuthEvent): string {
  switch (event.type) {
    case "auth_url":
      return `Open this URL in your browser:\n${event.url}\n${event.instructions === undefined ? "" : `${event.instructions}\n`}`;
    case "device_code":
      return `Open this URL in your browser:\n${event.verificationUri}\nEnter code: ${event.userCode}\n`;
    case "info": {
      const links = (event.links ?? [])
        .map((link) => `${link.label ?? "Link"}: ${link.url}`)
        .join("\n");
      return `${event.message}\n${links === "" ? "" : `${links}\n`}`;
    }
    case "progress":
      return `${event.message}\n`;
  }
}

function createAuthTerminal(): AuthTerminal {
  return {
    question: async (message, signal) => await question(message, signal),
    secret: async (message, signal) => await secret(message, signal),
    write: (message) => {
      process.stdout.write(message);
    },
  };
}

async function question(message: string, signal?: AbortSignal): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (signal === undefined) return await readline.question(message);
    return await readline.question(message, { signal });
  } catch (error) {
    if (signal?.aborted === true) throw new Error("Login cancelled", { cause: error });
    throw error;
  } finally {
    readline.close();
  }
}

async function secret(message: string, signal?: AbortSignal): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Secret login prompts require an interactive terminal");
  }
  output.write(message);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error): void => {
      input.removeListener("data", onData);
      signal?.removeEventListener("abort", onAbort);
      input.setRawMode(wasRaw);
      if (!wasRaw) input.pause();
      output.write("\n");
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const onAbort = (): void => {
      finish(new Error("Login cancelled"));
    };
    const onData = (chunk: Buffer | string): void => {
      for (const character of chunk.toString()) {
        const action = consumeSecretCharacter(character, value);
        value = action.value;
        if (action.done) {
          finish(action.cancelled ? new Error("Login cancelled") : undefined);
          return;
        }
      }
    };
    if (signal?.aborted === true) {
      finish(new Error("Login cancelled"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    input.on("data", onData);
  });
}

function consumeSecretCharacter(
  character: string,
  value: string,
): { readonly value: string; readonly done: boolean; readonly cancelled: boolean } {
  if (character === "\u0003") return { value, done: true, cancelled: true };
  if (character === "\r" || character === "\n") return { value, done: true, cancelled: false };
  if (character === "\u007f" || character === "\b") {
    return { value: Array.from(value).slice(0, -1).join(""), done: false, cancelled: false };
  }
  const next = character >= " " && character !== "\u001b" ? `${value}${character}` : value;
  return { value: next, done: false, cancelled: false };
}

async function inheritedProviderOwnsAuthentication(
  app: PiAppDefinition,
  providerId: string,
): Promise<boolean> {
  const selected = selectAppModel(app, {
    provider: providerId,
    model: "authentication-check",
    thinking: "off",
  });
  const inheritance = await resolveInheritance({
    app: selected,
    cwd: process.cwd(),
    agentDir: regularPiAgentDir(),
    providerId,
  });
  return inheritance.providerModule !== undefined;
}

export async function defaultRuntimeFactory(paths: RuntimePaths): Promise<LoginRuntime> {
  const runtime = await ModelRuntime.create({
    authPath: paths.authPath,
    modelsPath: paths.modelsPath,
    modelsStorePath: canonicalModelsStorePath(paths.authPath),
    allowModelNetwork: false,
  });
  await registerHuggingFaceOAuthProvider(runtime);
  return runtime;
}
