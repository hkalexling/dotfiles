// @ts-nocheck
/**
 * self-compaction — in-process replacement for the self-compact.sh driver.
 *
 * Model-facing surface: the `self_compact` tool. It only *schedules* a request;
 * the actual tree navigation happens after the agent turn settles, because
 * `navigateTree` is only available on command contexts and cannot run mid-turn.
 *
 * Bridge:
 *   1. tool `self_compact` validates the anchor, stores a pending request and
 *      tells the model to end its turn;
 *   2. `agent_settled` dispatches the internal command `/self-compact-run <id>`
 *      via `pi.sendUserMessage(..., { expandPromptTemplates: true })`. Pi defers
 *      that prompt until the settle emission finishes, so no user input can
 *      interleave before navigation;
 *   3. the command handler waits for idle, looks up the pinned target entry,
 *      calls `ctx.navigateTree(...)`, clears the editor text the anchor may have
 *      pre-filled, and submits the continuation, which starts the next turn on
 *      the compacted branch;
 *   4. every failure path sends a typed failure message that wakes the agent,
 *      instead of leaving it waiting or dying silently.
 *
 * Hold signal: while a request is scheduled, the extension emits
 * `self-compaction:hold` on `pi.events`. Other extensions that inject wake-ups
 * (herdr-subagents task notifications) hold them until the hold is released,
 * because a follow-up delivered before the settle keeps the run alive and
 * prevents `agent_settled` from firing at all.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { countDropped, resolveAnchor } from "./lib.ts";

const WIDGET_KEY = "self-compaction";

// Other extensions that inject wake-ups (task notifications, ...) listen on this
// channel and hold them while a compaction is scheduled. A follow-up delivered
// in that window would keep the run alive, so `agent_settled` would never fire
// and the compaction would never dispatch.
const HOLD_CHANNEL = "self-compaction:hold";
/** Waiting for the turn to settle: notifications are flushed as entries after this. */
const HOLD_WAIT_TTL_MS = 120_000;
/** Navigation can summarize a huge branch; keep the hold alive while it runs. */
const HOLD_NAV_TTL_MS = 900_000;

let pending = null;
let seq = 0;
let widgetTimer = null;

export default function selfCompaction(pi) {
  // -------------------------------------------------------------------------
  // cross-extension hold signal
  // -------------------------------------------------------------------------

  function emitHold(on, id, ttlMs) {
    try {
      pi.events.emit(
        HOLD_CHANNEL,
        on ? { on: true, id, ttlMs } : { on: false, id },
      );
    } catch {
      // a listener must never break the compaction mechanism
    }
  }

  function setWidget(ctx, lines) {
    try {
      ctx.ui.setWidget(WIDGET_KEY, lines);
    } catch {
      // never let UI updates break the mechanism
    }
  }

  function clearWidget(ctx) {
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      // ignore
    }
  }

  function showTransientWidget(ctx, line, ms = 8000) {
    if (widgetTimer) {
      clearTimeout(widgetTimer);
      widgetTimer = null;
    }
    setWidget(ctx, [line]);
    widgetTimer = setTimeout(() => {
      widgetTimer = null;
      clearWidget(ctx);
    }, ms);
    if (widgetTimer.unref) {
      widgetTimer.unref();
    }
  }

  function failureText(req, reason, navigated) {
    if (navigated) {
      return (
        `Self-compaction partially failed (id=${req.id}, anchor=${JSON.stringify(req.anchor)}, ` +
        `mode="${req.mode}", scope="${req.scope}"): ${reason}. The session tree was already ` +
        `moved, but the continuation was not submitted. Continue from the compacted branch.`
      );
    }
    return (
      `Self-compaction failed (id=${req.id}, anchor=${JSON.stringify(req.anchor)}, ` +
      `mode="${req.mode}", scope="${req.scope}"): ${reason}. Nothing was compacted and the ` +
      `session is unchanged. Continue normally, or retry self_compact with a different anchor.`
    );
  }

  function fail(ctx, req, reason, navigated = false) {
    // Release held notifications first, so the failure turn already has them.
    emitHold(false, req.id);
    showTransientWidget(ctx, `✗ self-compaction failed: ${reason}`, 12000);
    try {
      ctx.ui.notify(`Self-compaction failed: ${reason}`, "error");
    } catch {
      // ignore
    }
    try {
      pi.sendMessage(
        {
          customType: "self-compact-failure",
          content: failureText(req, reason, navigated),
          display: true,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch {
      // never let failure delivery break the session
    }
  }

  // -------------------------------------------------------------------------
  // model-facing tool
  // -------------------------------------------------------------------------

  const selfCompactTool = defineTool({
    name: "self_compact",
    label: "Self-Compact",
    description:
      "Compact this session's context by moving the session tree's active leaf back to an " +
      "earlier anchor, optionally summarizing the abandoned branch, then continuing from " +
      "there. Use ONLY when the user explicitly asks you to self-compact, free up context, " +
      "or reduce context. Never do this on your own initiative, and never use /compact.\n\n" +
      "After calling this tool: do not call any more tools and end your turn immediately. " +
      "Navigation cannot run mid-turn; it runs when your turn settles, and the continuation " +
      "you pass here starts your next turn on the compacted branch.\n\n" +
      "anchor — an integer index or a unique search phrase:\n" +
      '  • scope="user" (default): candidates are the user messages on the active branch, ' +
      "oldest first. 0 = oldest, -1 = newest, -2 = one before that, and so on.\n" +
      '  • scope="all": every message/summary entry on the active branch except system ' +
      "messages and bookkeeping entries (model changes, labels, usage), oldest first.\n" +
      "  • A user-message anchor compacts to just BEFORE it (everything before stays " +
      "verbatim; that message and everything after it are dropped or summarized). Any other " +
      "anchor compacts to just AFTER it.\n" +
      "  • A search phrase must match exactly one candidate on the active branch.\n\n" +
      'mode — "summarize" (default) preserves the abandoned work as a branch summary; ' +
      '"none" discards it (only for dead ends); "custom" uses customInstructions.\n\n' +
      "continuation — a single line submitted after compaction. Make it a self-contained " +
      "instruction to yourself: the branch summary may not carry every detail you need.",
    parameters: Type.Object({
      anchor: Type.String({
        description:
          'Index (e.g. 0, -1, -2) or a unique search phrase for the tree entry to navigate to.',
      }),
      mode: Type.Optional(
        StringEnum(["none", "summarize", "custom"], {
          description:
            'How to handle the abandoned branch. Default: "summarize".',
        }),
      ),
      customInstructions: Type.Optional(
        Type.String({
          description: 'Summary instructions, required when mode is "custom".',
        }),
      ),
      continuation: Type.String({
        description:
          "Single-line message submitted after compaction; starts your next turn on the compacted branch.",
      }),
      scope: Type.Optional(
        StringEnum(["user", "all"], {
          description:
            'Which tree entries are candidates. Default: "user" (user messages only).',
        }),
      ),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const anchor = String(params.anchor ?? "");
      const mode = params.mode ?? "summarize";
      const scope = params.scope ?? "user";
      const customInstructions = String(params.customInstructions ?? "");
      const continuation = String(params.continuation ?? "");

      if (!continuation.trim()) {
        throw new Error("continuation must not be empty");
      }
      if (/[\r\n]/.test(continuation)) {
        throw new Error(
          "continuation must be a single line (embedded newlines submit early); join lines with spaces",
        );
      }
      if (mode === "custom" && !customInstructions.trim()) {
        throw new Error('customInstructions is required when mode is "custom"');
      }
      if (pending) {
        throw new Error(
          `a self-compaction is already ${pending.phase} (id=${pending.id}, ` +
            `anchor=${JSON.stringify(pending.anchor)}, mode="${pending.mode}"); wait for its ` +
            `continuation or failure message before scheduling another`,
        );
      }

      const branch = ctx.sessionManager.getBranch();
      const resolved = resolveAnchor(branch, anchor, scope);
      if (!resolved.ok) {
        throw new Error(resolved.error);
      }
      if (resolved.candidate.id === ctx.sessionManager.getLeafId()) {
        throw new Error(
          `anchor ${JSON.stringify(anchor)} resolves to the current leaf ` +
            `(${resolved.candidate.preview}); navigating there would be a no-op. ` +
            `Pick an earlier anchor.`,
        );
      }
      const target = branch.find((entry) => entry.id === resolved.candidate.id);
      const dropped = target ? countDropped(branch, target) : 0;

      seq += 1;
      pending = {
        id: `sc-${Date.now().toString(36)}-${seq}`,
        anchor,
        mode,
        customInstructions: mode === "custom" ? customInstructions : undefined,
        continuation,
        scope,
        requestedAt: Date.now(),
        phase: "scheduled",
        // Pin the target entry resolved at tool time: re-resolving the anchor
        // after the turn settles would let negative indices in scope "all"
        // drift onto this turn's own assistant/tool-result entries.
        targetId: resolved.candidate.id,
        targetPreview: resolved.candidate.preview,
      };
      emitHold(true, pending.id, HOLD_WAIT_TTL_MS);

      setWidget(ctx, [
        `⏳ self-compaction scheduled (anchor=${JSON.stringify(anchor)}, mode=${mode}, dropping ${dropped})…`,
      ]);

      return {
        content: [
          {
            type: "text",
            text:
              `Self-compaction scheduled (id=${pending.id}, anchor=${JSON.stringify(anchor)}, ` +
              `mode="${mode}", scope="${scope}").\n` +
              `Target: [${resolved.index}] ${resolved.candidate.preview} — abandoning ` +
              `${dropped} branch entr${dropped === 1 ? "y" : "ies"}.\n` +
              `Do not call any more tools; end your turn now. The compaction runs after your ` +
              `turn settles, and your continuation starts your next turn on the compacted branch.`,
          },
        ],
        details: {
          id: pending.id,
          anchor,
          mode,
          scope,
          targetId: resolved.candidate.id,
          targetPreview: resolved.candidate.preview,
          index: resolved.index,
          total: resolved.total,
          dropped,
        },
      };
    },
  });

  pi.registerTool(selfCompactTool);

  // -------------------------------------------------------------------------
  // activation
  // -------------------------------------------------------------------------

  // pi restores a session's recorded tool set in two places:
  //   - on resume/construction (`_restoreToolsFromTranscript`), and
  //   - after every tree navigation (`navigateTree` calls it again).
  // A session whose branch record predates this extension therefore keeps
  // `self_compact` registered but inactive — even after a reload, a later
  // `/tree` navigation silently deactivates it again. Re-activate it after
  // both events; `--tools` exclusions never reach `getAllTools()`, so this
  // respects them.
  function ensureSelfCompactActive() {
    try {
      const registered = pi
        .getAllTools()
        .some((tool) => tool.name === "self_compact");
      if (!registered) {
        return;
      }
      const active = pi.getActiveTools();
      if (!active.includes("self_compact")) {
        pi.setActiveTools([...active, "self_compact"]);
      }
    } catch {
      // never let activation break a session event
    }
  }

  pi.on("session_start", ensureSelfCompactActive);
  pi.on("session_tree", ensureSelfCompactActive);

  // -------------------------------------------------------------------------
  // settle -> command bridge
  // -------------------------------------------------------------------------

  pi.on("agent_settled", () => {
    if (!pending || pending.phase !== "scheduled") {
      return;
    }
    const id = pending.id;
    pending.phase = "running";
    // Called while pi is still emitting `agent_settled`, so the prompt is
    // deferred until the emission completes: no user input can interleave
    // between this dispatch and the navigation.
    pi.sendUserMessage(`/self-compact-run ${id}`, { expandPromptTemplates: true });
  });

  pi.registerCommand("self-compact-run", {
    description:
      "Internal: run a self-compaction scheduled by the self_compact tool. Dispatched automatically after the agent settles; not meant to be called manually.",
    handler: async (args, ctx) => {
      const id = String(args ?? "").trim();
      const req = pending;
      if (!req) {
        return;
      }
      if (id && req.id !== id) {
        // A stale dispatch for a different request; leave the live one alone.
        return;
      }
      pending = null;

      let navigated = false;
      try {
        await ctx.waitForIdle();
        const branch = ctx.sessionManager.getBranch();
        const target = branch.find((entry) => entry.id === req.targetId);
        if (!target) {
          throw new Error(
            `the resolved target (${req.targetPreview}) is no longer on the active branch`,
          );
        }
        if (req.targetId === ctx.sessionManager.getLeafId()) {
          throw new Error(
            "the resolved target is now the current leaf, so there is nothing to drop",
          );
        }
        const dropped = countDropped(branch, target);

        setWidget(ctx, [
          `⏳ self-compaction: navigating (anchor=${JSON.stringify(req.anchor)}, mode=${req.mode})…`,
        ]);

        // Re-arm the hold for the navigation window: it can take minutes, and a
        // TTL flush mid-navigation would append entries to the branch that is
        // about to be abandoned.
        emitHold(true, req.id, HOLD_NAV_TTL_MS);

        const result = await ctx.navigateTree(req.targetId, {
          summarize: req.mode !== "none",
          customInstructions:
            req.mode === "custom" ? req.customInstructions : undefined,
        });
        if (result.cancelled) {
          throw new Error(
            "navigation was cancelled (branch summary aborted or blocked by an extension)",
          );
        }
        navigated = true;

        // A user-message/custom-message anchor pre-fills the editor with the
        // anchor text; clear it so the continuation is the only pending input.
        try {
          ctx.ui.setEditorText("");
        } catch {
          // ignore
        }

        showTransientWidget(
          ctx,
          `✓ self-compaction complete (anchor=${JSON.stringify(req.anchor)}, mode=${req.mode}, abandoned ${dropped})`,
          8000,
        );

        // Navigation can take a while (branch summarization). User input is
        // processed as soon as the session leaves the compacting state, and
        // other extensions can trigger turns too, so a prompt submitted right
        // after navigation races with this continuation. Let the queued input
        // start its turn, wait it out, then deliver the continuation as a
        // follow-up so it queues instead of failing with "already processing".
        await ctx.waitForIdle();
        await new Promise((resolve) => setTimeout(resolve, 200));
        await ctx.waitForIdle();

        const prefix =
          `Self-compaction complete (id=${req.id}, anchor=${JSON.stringify(req.anchor)}, ` +
          `mode="${req.mode}", abandoned ${dropped} branch entr${dropped === 1 ? "y" : "ies"}). ` +
          `Continue: `;
        // Release held notifications immediately before the continuation: the
        // flush is synchronous and appends them to the compacted branch, so
        // nothing can interleave and re-race the settle.
        emitHold(false, req.id);
        pi.sendUserMessage(prefix + req.continuation, { deliverAs: "followUp" });
      } catch (err) {
        fail(ctx, req, err instanceof Error ? err.message : String(err), navigated);
      }
    },
  });

  // -------------------------------------------------------------------------
  // cleanup
  // -------------------------------------------------------------------------

  pi.on("session_shutdown", () => {
    if (widgetTimer) {
      clearTimeout(widgetTimer);
      widgetTimer = null;
    }
    emitHold(false);
    pending = null;
  });
}
