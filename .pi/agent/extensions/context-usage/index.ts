// @ts-nocheck
/**
 * context-usage — a tiny model-facing tool that reports the current
 * context-window usage from `ctx.getContextUsage()`. Works in any session
 * (TUI/RPC/JSON/print), not just inside herdr.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { formatContextUsage } from "./lib.ts";

const contextUsageTool = defineTool({
  name: "context_usage",
  label: "Context Usage",
  description:
    "Show this session's current context-window usage: estimated tokens, the active model's context window, percent used, model id, and thinking level. Use when deciding whether to compact, fork, or delegate, or when the user asks how full the context is. Right after compaction, tokens and percent are unknown until the next response.",
  annotations: { readOnlyHint: true },
  parameters: Type.Object({}),
  async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
    const usage =
      ctx && typeof ctx.getContextUsage === "function"
        ? ctx.getContextUsage()
        : undefined;
    const { text, details } = formatContextUsage(
      usage,
      ctx && ctx.model,
      ctx && ctx.thinkingLevel,
    );
    return { content: [{ type: "text", text }], details };
  },
});

export default function (pi) {
  pi.registerTool(contextUsageTool);
}
