import { describe, expect, it } from "vitest";
import { resolveAgentInvocationConfig } from "#src/config/invocation-config";
import type { AgentConfig } from "#src/types";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    systemPrompt: "Test agent",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    ...overrides,
  };
}

describe("resolveAgentInvocationConfig", () => {
  it("prefers tool-call params model over agent frontmatter", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        model: "provider/config-model",
        thinking: "high",
      }),
      {
        model: "provider/param-model",
        thinking: "minimal",
      },
    );

    // params override frontmatter when no settings are present
    expect(resolved.modelInput).toBe("provider/param-model");
    expect(resolved.modelFromParams).toBe(true);
    expect(resolved.modelFromSettings).toBe(false);
    expect(resolved.thinking).toBe("minimal");
  });

  it("falls back to agent frontmatter when no params and no settings", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        model: "provider/config-model",
        thinking: "high",
      }),
      {},
    );

    expect(resolved.modelInput).toBe("provider/config-model");
    expect(resolved.modelFromParams).toBe(false);
    expect(resolved.modelFromSettings).toBe(false);
    expect(resolved.thinking).toBe("high");
  });

  it("prefers centralized settings over agent frontmatter", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        model: "provider/config-model",
        thinking: "high",
      }),
      {},
      {
        getAgentDefaults: () => ({ model: "provider/settings-model", thinking: "low" }),
      },
    );

    expect(resolved.modelInput).toBe("provider/settings-model");
    expect(resolved.modelFromParams).toBe(false);
    expect(resolved.modelFromSettings).toBe(true);
    expect(resolved.thinking).toBe("low");
  });

  it("prefers tool-call params over centralized settings and frontmatter", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        model: "provider/config-model",
        thinking: "high",
      }),
      {
        model: "provider/param-model",
        thinking: "minimal",
      },
      {
        getAgentDefaults: () => ({ model: "provider/settings-model", thinking: "low" }),
      },
    );

    // Full precedence: params > settings > frontmatter
    expect(resolved.modelInput).toBe("provider/param-model");
    expect(resolved.modelFromParams).toBe(true);
    expect(resolved.modelFromSettings).toBe(/* false because params won */ false);
    expect(resolved.thinking).toBe("minimal");
  });

  it("uses tool-call params when no agent config is available", () => {
    const resolved = resolveAgentInvocationConfig(undefined, {
      model: "provider/param-model",
      thinking: "minimal",
      max_turns: 3,
      inherit_context: true,
      run_in_background: true,
    });

    expect(resolved.modelInput).toBe("provider/param-model");
    expect(resolved.modelFromParams).toBe(true);
    expect(resolved.thinking).toBe("minimal");
    expect(resolved.maxTurns).toBe(3);
    expect(resolved.inheritContext).toBe(true);
    expect(resolved.runInBackground).toBe(true);
  });

  it("lets parent fill in booleans when config leaves them undefined", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        inheritContext: undefined,
        runInBackground: undefined,
      }),
      {
        inherit_context: true,
        run_in_background: true,
      },
    );

    expect(resolved.inheritContext).toBe(true);
    expect(resolved.runInBackground).toBe(true);
  });

  it("defaults booleans to false when neither config nor params set them", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        inheritContext: undefined,
        runInBackground: undefined,
      }),
      {},
    );

    expect(resolved.inheritContext).toBe(false);
    expect(resolved.runInBackground).toBe(false);
  });

  describe("modelFromSettings flag", () => {
    it("is true when model comes from settings (not params, not frontmatter)", () => {
      const resolved = resolveAgentInvocationConfig(
        makeConfig({ model: undefined }),
        {},
        { getAgentDefaults: () => ({ model: "provider/settings-model" }) },
      );

      expect(resolved.modelInput).toBe("provider/settings-model");
      expect(resolved.modelFromParams).toBe(false);
      expect(resolved.modelFromSettings).toBe(true);
    });

    it("is false when model comes from frontmatter (no settings)", () => {
      const resolved = resolveAgentInvocationConfig(
        makeConfig({ model: "provider/config-model" }),
        {},
      );

      expect(resolved.modelInput).toBe("provider/config-model");
      expect(resolved.modelFromParams).toBe(false);
      expect(resolved.modelFromSettings).toBe(false);
    });
  });
});
