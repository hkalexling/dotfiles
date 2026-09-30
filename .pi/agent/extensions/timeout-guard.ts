/**
 * Timeout Guard — outright reject bash timeouts over 15 minutes.
 *
 * pi's bash `timeout` unit is SECONDS (not milliseconds like other
 * harnesses), with no default (unset = runs forever) and a useless
 * built-in ceiling (~24.8 days). Agents routinely pass 60000 thinking
 * "60 seconds in ms" and pin a turn for 16 hours.
 *
 * Policy: timeout > 900s is blocked with an explanation. Missing or
 * valid timeouts pass through untouched (missing = pi default = infinite).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MAX_TIMEOUT_S = 900; // 15 minutes

/** Returns the block reason when over max, else null (allowed). */
export function checkBashTimeout(timeout: unknown): string | null {
  if (typeof timeout === "number" && timeout > MAX_TIMEOUT_S) {
    const req = Number.isFinite(timeout) ? `${timeout}` : "Infinity";
    return [
      `Blocked: timeout ${req} exceeds the ${MAX_TIMEOUT_S}s (15 min) maximum.`,
      "",
      "Note: pi's bash timeout unit is seconds, not milliseconds like other",
      "harnesses — if you meant 60 seconds, pass timeout: 60, not 60000.",
      "",
      "For tasks that genuinely need longer, run in background and poll:",
      `  nohup <cmd> > /tmp/task.log 2>&1 & echo "pid $!"`,
      "  # then check progress with short sleeps, each well under 900s:",
      "  sleep 60; tail -5 /tmp/task.log",
    ].join("\n");
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    const e = event as unknown as {
      toolName?: string;
      input?: { timeout?: unknown };
    };
    if (e.toolName !== "bash") return undefined;
    const reason = checkBashTimeout(e.input?.timeout);
    if (reason) return { block: true, reason };
    return undefined;
  });

  pi.on("before_agent_start", async (event) => {
    const e = event as unknown as { systemPrompt?: string };
    return {
      systemPrompt:
        `${e.systemPrompt ?? ""}\n\nBash timeouts: unit is seconds (not ms), ` +
        `max ${MAX_TIMEOUT_S}s (15 min) — larger values are rejected outright. ` +
        `For longer tasks, background to a file (nohup … &) and poll with sleep.`,
    };
  });

  pi.registerCommand("timeout-guard", {
    description: "Show bash timeout policy, or test a value",
    handler: async (args, ctx) => {
      const text = (args ?? "").trim();
      if (text.startsWith("test")) {
        const rest = text.replace(/^test\s+/, "");
        if (!rest) {
          ctx.ui.notify("Usage: /timeout-guard test <seconds>", "warning");
          return;
        }
        const v = Number(rest);
        if (!Number.isFinite(v) && rest.toLowerCase() !== "infinity") {
          ctx.ui.notify(`Not a number: ${rest}`, "warning");
          return;
        }
        const reason = checkBashTimeout(v);
        ctx.ui.notify(
          reason ?? `ALLOWED: timeout ${rest} (max ${MAX_TIMEOUT_S}s)`,
          reason ? "warning" : "info",
        );
        return;
      }
      ctx.ui.notify(
        `timeout-guard: bash timeout is in seconds (not ms); max ${MAX_TIMEOUT_S}s (15 min). ` +
          `Larger values are rejected; background long tasks and poll.`,
        "info",
      );
    },
  });
}
