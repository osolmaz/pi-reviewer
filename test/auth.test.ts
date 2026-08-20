import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadReviewerApp } from "../src/app.js";
import { regularPiAuthPath } from "../src/auth-path.js";
import { loginReviewerApp, type AuthTerminal } from "../src/auth.js";

const cleanup: string[] = [];
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appOptions = { packageRoot, piCommand: [process.execPath] };

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function terminal(answers: string[]): AuthTerminal & { output: string[] } {
  const output: string[] = [];
  return {
    output,
    question: () => Promise.resolve(answers.shift() ?? ""),
    secret: () => Promise.resolve(answers.shift() ?? ""),
    write: (message) => {
      output.push(message);
    },
  };
}

describe("pi-reviewer authentication", () => {
  it("uses regular Pi credentials with app-local model paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-reviewer-auth-"));
    cleanup.push(root);
    vi.stubEnv("PI_FACTORY_STATE_DIR", path.join(root, "factory"));
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "overridden-agent"));
    const loaded = await loadReviewerApp(appOptions);
    const app = {
      ...loaded,
      stateDir: path.join(root, "state"),
      sessionDir: path.join(root, "state", "sessions"),
    };
    const ui = terminal(["authorization-code"]);
    let receivedProvider = "";
    let receivedMethod = "";
    let authPath = "";
    let modelsPath = "";
    await loginReviewerApp(
      app,
      "openai-codex",
      ui,
      (paths) => {
        authPath = paths.authPath;
        modelsPath = paths.modelsPath;
        return Promise.resolve({
          getProviders: () => [{ id: "openai-codex", name: "OpenAI Codex", auth: { oauth: {} } }],
          login: async (provider, method, interaction) => {
            receivedProvider = provider;
            receivedMethod = method;
            interaction.notify({
              type: "auth_url",
              url: "https://example.test/auth",
              instructions: "Continue in the browser",
            });
            interaction.notify({
              type: "device_code",
              userCode: "ABCD-EFGH",
              verificationUri: "https://example.test/device",
            });
            interaction.notify({ type: "progress", message: "Waiting" });
            await interaction.prompt({ type: "manual_code", message: "Paste code" });
            return {};
          },
        });
      },
      () => Promise.resolve(false),
    );

    expect(receivedProvider).toBe("openai-codex");
    expect(receivedMethod).toBe("oauth");
    expect(authPath).toBe(regularPiAuthPath());
    expect(authPath).not.toBe(path.join(root, "overridden-agent", "auth.json"));
    expect(modelsPath).toBe(path.join(root, "state", "pi-config-runtime", "models.json"));
    expect(ui.output.join("")).toContain("ABCD-EFGH");
    expect(ui.output.join("")).toContain("Continue in the browser");
    expect(ui.output.join("")).toContain("Waiting");
    expect(ui.output.join("")).toContain("Authenticated OpenAI Codex in the regular Pi profile");
  });

  it("does not create a fallback credential for provider-managed authentication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-reviewer-provider-auth-"));
    cleanup.push(root);
    const app = await loadReviewerApp(appOptions);
    const createRuntime = vi.fn(() =>
      Promise.resolve({
        getProviders: () => [],
        login: vi.fn(() => Promise.resolve({})),
      }),
    );
    await expect(
      loginReviewerApp(app, "managed", terminal([]), createRuntime, () => Promise.resolve(true)),
    ).rejects.toThrow("managed by the selected provider");
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("resolves auth.json from the regular Pi home", () => {
    expect(regularPiAuthPath(path.join("root", "home"))).toBe(
      path.join("root", "home", ".pi", "agent", "auth.json"),
    );
  });

  it("selects providers and API-key methods without exposing the secret", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-reviewer-auth-select-"));
    cleanup.push(root);
    vi.stubEnv("PI_FACTORY_STATE_DIR", path.join(root, "factory"));
    const loaded = await loadReviewerApp(appOptions);
    const app = {
      ...loaded,
      stateDir: path.join(root, "state"),
      sessionDir: path.join(root, "state", "sessions"),
    };
    const ui = terminal(["1", "2", "top-secret"]);
    let secret = "";
    await loginReviewerApp(
      app,
      undefined,
      ui,
      () =>
        Promise.resolve({
          getProviders: () => [
            {
              id: "provider",
              name: "Provider",
              auth: { oauth: {}, apiKey: { login: () => undefined } },
            },
          ],
          login: async (_provider, method, interaction) => {
            expect(method).toBe("api_key");
            secret = await interaction.prompt({ type: "secret", message: "API key" });
            interaction.notify({
              type: "info",
              message: "Saved",
              links: [{ label: "Docs", url: "https://example.test/docs" }],
            });
            return {};
          },
        }),
      () => Promise.resolve(false),
    );

    expect(secret).toBe("top-secret");
    expect(ui.output.join("")).not.toContain("top-secret");
    expect(ui.output.join("")).toContain("Docs: https://example.test/docs");
  });

  it("rejects providers without interactive login", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-reviewer-auth-missing-"));
    cleanup.push(root);
    vi.stubEnv("PI_FACTORY_STATE_DIR", path.join(root, "factory"));
    const loaded = await loadReviewerApp(appOptions);
    const app = {
      ...loaded,
      stateDir: path.join(root, "state"),
      sessionDir: path.join(root, "state", "sessions"),
    };
    const runtime = () =>
      Promise.resolve({
        getProviders: () => [],
        login: () => Promise.resolve({}),
      });
    await expect(loginReviewerApp(app, "missing", terminal([]), runtime)).rejects.toThrow(
      "no interactive login",
    );
    await expect(loginReviewerApp(app, undefined, terminal([]), runtime)).rejects.toThrow(
      "No providers",
    );
  });
});
