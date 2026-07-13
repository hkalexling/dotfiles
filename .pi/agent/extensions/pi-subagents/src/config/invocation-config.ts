import type { AgentConfig, ThinkingLevel } from "#src/types";
import type { AgentDefaults } from "#src/settings";

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  max_turns?: number;
  run_in_background?: boolean;
  inherit_context?: boolean;
}

/** Narrow settings interface for invocation config resolution. */
export interface InvocationSettings {
  getAgentDefaults(agentName: string): AgentDefaults;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
  settings?: InvocationSettings,
): {
  modelInput?: string;
  modelFromParams: boolean;
  modelFromSettings: boolean;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
} {
  // Centralized defaults from subagents.json (global + per-agent overrides)
  const agentDefaults = settings?.getAgentDefaults(agentConfig?.name ?? "general-purpose");
  const settingsModel = agentDefaults?.model;
  const settingsThinking = agentDefaults?.thinking;

  // Precedence: tool params > centralized per-agent > centralized global > agent frontmatter/builtin
  const modelInput =
    params.model
    ?? settingsModel
    ?? agentConfig?.model;

  const modelFromParams = params.model != null;
  const modelFromSettings = params.model == null && settingsModel != null;

  const thinking = (
    params.thinking
    ?? settingsThinking
    ?? agentConfig?.thinking
  ) as ThinkingLevel | undefined;

  return {
    modelInput,
    modelFromParams,
    modelFromSettings,
    thinking,
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,
  };
}
