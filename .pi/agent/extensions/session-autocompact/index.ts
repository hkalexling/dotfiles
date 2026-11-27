/**
 * session-autocompact — let ONE session use Pi's native auto-compaction while the
 * global `compaction.enabled` setting stays false.
 *
 *   /autocompact          status for the current session
 *   /autocompact on       allow Pi's native scheduler in this session
 *   /autocompact off      pin this session off
 *   /autocompact on 150k  allow it and compact once context exceeds 150k tokens
 *   /autocompact limit 150k / limit off
 *                         set or clear the session's compaction limit
 *
 * What it changes: the session-local `compaction.enabled` view of the live
 * settings instance (see native-bridge.ts). Pi's own threshold check, overflow
 * recovery, `keepRecentTokens`, and per-model overrides stay exactly as they
 * are. With a session limit, `reserveTokens` as seen by Pi's threshold check is
 * raised (never lowered) so the native check fires at the limit. Nothing is
 * compacted by turning it on; the next native check simply becomes allowed to run.
 *
 * What it never does: write global settings, call `AgentSession.setAutoCompaction
 * Enabled()`, run `ctx.compact()`, or expose an LLM-facing tool.
 *
 * Durability: the choice is stored as a custom session entry
 * `{ version, sessionId, enabled, thresholdTokens }` and re-applied on `/resume` and `/reload`.
 * New sessions, `/fork`, and `/clone` start with no session setting. Tree
 * navigation cannot undo a session-wide choice (see state.ts).
 *
 * Requires `/reload` after installing or editing this file.
 */

import * as piModule from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import {
  attachSessionCompactionOverride,
  captureSettingsManager,
  globalCompactionEnabled,
  readSettingViews,
  readThresholdView,
  settingsManagerSupportError,
  verifySessionCompactionOverride,
  verifySessionCompactionThreshold,
  type AttachmentHandle,
  type SettingsManagerLike,
} from "./native-bridge.ts";
import {
  COMMAND_NAME,
  CUSTOM_TYPE,
  createRecord,
  formatChangeText,
  formatFooterText,
  formatStatusText,
  formatThresholdChangeText,
  formatTokens,
  isValidThresholdTokens,
  MIN_THRESHOLD_TOKENS,
  parseTokenCount,
  readSessionPreference,
  STATUS_KEY,
  USAGE,
  type EntryLike,
  type PreferenceResult,
  type StatusFacts,
} from "./state.ts";

/** Looked up rather than imported directly, so a missing export is a reported
 * limitation instead of a broken extension. */
const SETTINGS_MANAGER_CLASS: unknown = (piModule as { SettingsManager?: unknown }).SettingsManager;

const ARGUMENTS = ["on", "off", "limit", "limit off", "status"];

const CLEAR_WORDS = new Set(["off", "none", "clear", "reset"]);

interface LiveSession {
  sessionId: string;
  /** `undefined`: no session setting; follow the effective settings. */
  preference: boolean | undefined;
  /** `undefined`: no session compaction limit. */
  thresholdTokens: number | undefined;
  /** Whether Pi's `getCompactionSettings(model)` was confirmed to apply the limit for the current model. */
  thresholdConfirmed?: boolean;
  manager?: SettingsManagerLike;
  handle?: AttachmentHandle;
  supported: boolean;
  honored: boolean;
  unsupportedReason?: string;
  stats?: PreferenceResult;
}

export default function sessionAutocompact(pi: ExtensionAPI) {
  // Deliberately per-factory: two extension instances in one process (SDK use,
  // a reloaded runtime reusing this module) must never share a session
  // preference or detach each other's attachments.
  let live: LiveSession | undefined;

  const classError = settingsManagerSupportError(SETTINGS_MANAGER_CLASS, "SettingsManager");

  function notify(ctx: ExtensionContext, text: string, kind: "info" | "warning" | "error" = "info"): void {
    try {
      if (ctx.hasUI) {
        ctx.ui.notify(text, kind);
      }
    } catch {
      // UI output is never allowed to break the setting itself.
    }
  }

  function showStatus(ctx: ExtensionContext, text: string | undefined): void {
    try {
      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, text);
      }
    } catch {
      // ignore
    }
  }

  function currentModel(ctx: ExtensionContext | undefined): unknown {
    try {
      return ctx?.model;
    } catch {
      return undefined;
    }
  }

  function modelLabel(model: unknown): string | undefined {
    if (!model || typeof model !== "object") {
      return undefined;
    }
    const { provider, id } = model as { provider?: unknown; id?: unknown };
    if (typeof id !== "string") {
      return undefined;
    }
    return typeof provider === "string" ? `${provider}/${id}` : id;
  }

  function facts(ctx: ExtensionContext | undefined, manager?: SettingsManagerLike): StatusFacts {
    const target = manager ?? live?.manager;
    const views = readSettingViews(target);
    const model = currentModel(ctx);
    const threshold = target ? readThresholdView(target, model) : undefined;
    return {
      sessionId: live?.sessionId ?? "",
      preference: live?.preference,
      thresholdTokens: live?.thresholdTokens,
      thresholdConfirmed: live?.thresholdConfirmed,
      modelLabel: modelLabel(model),
      contextWindow: threshold?.contextWindow,
      nativeTriggerTokens: threshold?.nativeTriggerTokens,
      effectiveTriggerTokens: threshold?.triggerTokens,
      keepRecentTokens: threshold?.keepRecentTokens,
      honored: live?.honored === true,
      supported: live?.supported !== false && classError === undefined,
      unsupportedReason: live?.unsupportedReason ?? classError,
      effectiveEnabled: views.effective,
      globalEnabled: views.global,
      projectEnabled: views.project,
      settingsReadable: views.readable,
      ignoredEntries: live?.stats?.ignored,
      foreignEntries: live?.stats?.foreign,
    };
  }

  function refreshStatusUI(ctx: ExtensionContext): void {
    showStatus(ctx, formatFooterText(facts(ctx)));
  }

  function teardown(): void {
    const handle = live?.handle;
    live = undefined;
    try {
      handle?.detach();
    } catch {
      // ignore
    }
  }

  /** Reach (and cache) the settings instance of the current session. */
  function ensureManager(): SettingsManagerLike | undefined {
    if (live?.manager) {
      return live.manager;
    }
    if (classError !== undefined) {
      return undefined;
    }
    let capture;
    try {
      capture = captureSettingsManager(SETTINGS_MANAGER_CLASS, () => pi.getSettings());
    } catch (error) {
      capture = {
        ok: false as const,
        error: `unexpected failure while reaching the session settings instance: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!capture.ok) {
      if (live) {
        live.supported = false;
        live.honored = false;
        live.unsupportedReason = capture.error;
      }
      return undefined;
    }
    if (live) {
      live.manager = capture.value;
      live.supported = true;
      live.unsupportedReason = undefined;
    }
    return capture.value;
  }

  /** Make the live settings instance match `live.preference`; false = fail closed. */
  function applyOverride(ctx: ExtensionContext): boolean {
    if (!live) {
      return false;
    }
    if (live.handle) {
      try {
        live.handle.detach();
      } catch {
        // ignore
      }
      live.handle = undefined;
    }
    live.honored = false;
    live.thresholdConfirmed = undefined;

    if (live.preference === undefined && live.thresholdTokens === undefined) {
      // No session setting: leave Pi's own settings access untouched.
      live.supported = classError === undefined;
      live.unsupportedReason = classError;
      return true;
    }

    const manager = ensureManager();
    if (!manager) {
      live.supported = false;
      live.honored = false;
      live.unsupportedReason = live.unsupportedReason ?? classError ?? "the session settings instance is unreachable";
      return false;
    }

    const globalBefore = globalCompactionEnabled(manager);
    // A restore failure during a later detach() has no return value: route it here.
    const report = (message: string): void => {
      notify(ctx, `auto-compact: ${message}`, "warning");
    };

    let attach;
    try {
      attach = attachSessionCompactionOverride(manager, {
        read: () => live?.preference,
        readThreshold: () => live?.thresholdTokens,
        report,
      });
    } catch (error) {
      attach = {
        ok: false as const,
        error: `unexpected failure while applying the session setting: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!attach.ok) {
      live.supported = false;
      live.honored = false;
      live.unsupportedReason = attach.error;
      return false;
    }
    live.handle = attach.value;

    const verified = verifyAll(ctx, manager, globalBefore);
    if (!verified.ok) {
      // The assumption broke: remove the patch and refuse to claim the setting.
      try {
        live.handle.detach();
      } catch {
        // ignore
      }
      live.handle = undefined;
      live.supported = false;
      live.honored = false;
      live.unsupportedReason = verified.error ?? "the native scheduler did not confirm the setting";
      return false;
    }

    live.supported = true;
    live.honored = true;
    live.unsupportedReason = undefined;
    return true;
  }

  /**
   * Confirm the on/off value (when set) and the limit (when set) through the
   * live instance. Updates `live.thresholdConfirmed`. Never throws.
   */
  function verifyAll(
    ctx: ExtensionContext | undefined,
    manager: SettingsManagerLike,
    globalBefore: boolean | undefined,
  ): { ok: boolean; error?: string } {
    if (!live) {
      return { ok: false, error: "no live session" };
    }
    if (live.preference !== undefined) {
      const verified = safeVerify(manager, live.preference, globalBefore);
      if (!verified.ok) {
        return verified;
      }
    }
    try {
      const threshold = verifySessionCompactionThreshold(manager, currentModel(ctx), live.thresholdTokens);
      if (!threshold.ok) {
        live.thresholdConfirmed = false;
        return { ok: false, error: threshold.error };
      }
      live.thresholdConfirmed = live.thresholdTokens === undefined ? undefined : threshold.confirmed;
    } catch (error) {
      live.thresholdConfirmed = false;
      return {
        ok: false,
        error: `unexpected failure while confirming the compaction limit: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { ok: true };
  }

  /**
   * Re-check the live instance before reporting status. If the patch stopped
   * doing what it claims, drop it instead of reporting a setting that is not in
   * effect.
   */
  /** Confirms a live attachment, never throwing. */
  function safeVerify(
    manager: SettingsManagerLike,
    expected: boolean,
    globalBefore: boolean | undefined,
  ): { ok: boolean; error?: string } {
    try {
      return verifySessionCompactionOverride(manager, expected, globalBefore);
    } catch (error) {
      return {
        ok: false,
        error: `unexpected failure while confirming the session setting: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  function refreshVerification(ctx: ExtensionContext): void {
    if (!live || (live.preference === undefined && live.thresholdTokens === undefined) || !live.handle || !live.manager) {
      return;
    }
    const manager = live.manager;
    const globalBefore = globalCompactionEnabled(manager);
    const verified = verifyAll(ctx, manager, globalBefore);
    if (verified.ok) {
      live.honored = true;
      live.supported = true;
      live.unsupportedReason = undefined;
      return;
    }
    try {
      live.handle.detach();
    } catch {
      // ignore
    }
    live.handle = undefined;
    live.supported = false;
    live.honored = false;
    live.unsupportedReason = verified.error ?? "the native scheduler did not confirm the setting";
  }

  /** Rebuild `live` from the current session (also used by session_start). */
  function loadSession(ctx: ExtensionContext): LiveSession | undefined {
    let sessionId: string | undefined;
    let entries: readonly EntryLike[] = [];
    try {
      sessionId = ctx.sessionManager.getSessionId();
      entries = ctx.sessionManager.getEntries() as readonly EntryLike[];
    } catch (error) {
      live = {
        sessionId: "",
        preference: undefined,
        thresholdTokens: undefined,
        supported: false,
        honored: false,
        unsupportedReason: `session state is not readable: ${error instanceof Error ? error.message : String(error)}`,
      };
      return live;
    }
    if (!sessionId) {
      live = {
        sessionId: "",
        preference: undefined,
        thresholdTokens: undefined,
        supported: false,
        honored: false,
        unsupportedReason: "this session has no session id, so a session-scoped setting cannot be stored",
      };
      return live;
    }

    const stats = readSessionPreference(entries, sessionId);
    live = {
      sessionId,
      preference: stats.enabled,
      thresholdTokens: stats.thresholdTokens,
      supported: classError === undefined,
      honored: false,
      unsupportedReason: classError,
      stats,
    };
    return live;
  }

  interface Change {
    enabled?: boolean;
    /** `null` clears the limit; `undefined` leaves it as it is. */
    thresholdTokens?: number | null;
  }

  function changeSetting(ctx: ExtensionContext, change: Change): void {
    const current = live ?? loadSession(ctx);
    if (!current) {
      return;
    }
    if (!current.sessionId) {
      notify(ctx, `auto-compact unchanged for this session: ${current.unsupportedReason ?? "no session id"}`, "error");
      return;
    }
    const previous = { preference: current.preference, thresholdTokens: current.thresholdTokens };
    if (change.enabled !== undefined) {
      current.preference = change.enabled;
    }
    if (change.thresholdTokens !== undefined) {
      current.thresholdTokens = change.thresholdTokens ?? undefined;
    }

    if (!applyOverride(ctx)) {
      const reason = current.unsupportedReason ?? "the session setting could not be reached";
      current.preference = previous.preference;
      current.thresholdTokens = previous.thresholdTokens;
      applyOverride(ctx);
      notify(ctx, `auto-compact unchanged for this session: ${reason}`, "error");
      refreshStatusUI(ctx);
      return;
    }

    try {
      pi.appendEntry(CUSTOM_TYPE, createRecord(current.sessionId, current.preference, current.thresholdTokens));
    } catch (error) {
      notify(
        ctx,
        `auto-compact is set for this session but could not be stored in the session: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }

    const after = facts(ctx, current.manager);
    if (change.enabled !== undefined) {
      notify(ctx, formatChangeText(after, current.honored), current.honored ? "info" : "warning");
    } else {
      notify(ctx, formatThresholdChangeText(after), current.thresholdConfirmed === false ? "warning" : "info");
    }
    refreshStatusUI(ctx);
  }

  /** Parse a limit argument: a token count, or one of the clear words. */
  function parseLimit(ctx: ExtensionContext, raw: string): number | null | undefined {
    const text = raw.trim().toLowerCase();
    if (CLEAR_WORDS.has(text)) {
      return null;
    }
    const value = parseTokenCount(text);
    if (value === undefined) {
      notify(ctx, `invalid token count: ${raw}. Use e.g. 150000, 150k, or 1.5m. Usage: ${USAGE}`, "error");
      return undefined;
    }
    if (!isValidThresholdTokens(value)) {
      notify(
        ctx,
        `compaction limit must be at least ${formatTokens(MIN_THRESHOLD_TOKENS)} tokens (got ${value}). Usage: ${USAGE}`,
        "error",
      );
      return undefined;
    }
    return value;
  }

  pi.on("session_start", (_event, ctx) => {
    // `session_start` can fire twice for one session replacement in this Pi
    // version: drop any previous attachment before capturing again.
    teardown();
    const session = loadSession(ctx);
    if (!session) {
      return;
    }
    if (!session.supported) {
      notify(ctx, `auto-compact: unavailable - ${session.unsupportedReason ?? "unsupported Pi build"}`, "warning");
      refreshStatusUI(ctx);
      return;
    }
    if (session.preference !== undefined || session.thresholdTokens !== undefined) {
      if (applyOverride(ctx)) {
        const limit =
          session.thresholdTokens !== undefined ? `, compacting above ${formatTokens(session.thresholdTokens)} tokens` : "";
        if (session.preference === true) {
          notify(ctx, `auto-compact: ON for this session (restored${limit}). Only this session is affected.`, "info");
        }
      } else {
        const wanted =
          session.preference === true
            ? "enable"
            : session.preference === false
              ? "disable"
              : "apply the compaction limit for";
        notify(
          ctx,
          `auto-compact: could not ${wanted} this session - ${session.unsupportedReason ?? "unsupported Pi build"}`,
          "warning",
        );
      }
    }
    refreshStatusUI(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    showStatus(ctx, undefined);
    teardown();
  });

  pi.registerCommand(COMMAND_NAME, {
    description:
      "Show or change Pi's native auto-compaction for the current session only: on [tokens] | off | limit <tokens>|off | status.",
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      const items = ARGUMENTS.filter((value) => value.startsWith(argumentPrefix)).map((value) => ({
        value,
        label: value,
      }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const words = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      const action = (words[0] ?? "").toLowerCase();
      const rest = words.slice(1);

      if (action === "" || action === "status") {
        if (!live) {
          loadSession(ctx);
        }
        // Status reports what the settings actually say, so reach the instance
        // first instead of describing a session we have never read.
        const manager = ensureManager();
        refreshVerification(ctx);
        notify(ctx, formatStatusText(facts(ctx, manager)));
        refreshStatusUI(ctx);
        return;
      }

      if (action === "off" && rest.length === 0) {
        changeSetting(ctx, { enabled: false });
        return;
      }

      if (action === "on") {
        if (rest.length === 0) {
          changeSetting(ctx, { enabled: true });
          return;
        }
        if (rest.length === 1) {
          const limit = parseLimit(ctx, rest[0]);
          if (limit === undefined) {
            return;
          }
          changeSetting(ctx, { enabled: true, thresholdTokens: limit });
          return;
        }
      }

      if (action === "limit") {
        if (rest.length !== 1) {
          notify(ctx, `limit needs one value, e.g. /autocompact limit 150k or /autocompact limit off. Usage: ${USAGE}`, "error");
          return;
        }
        const limit = parseLimit(ctx, rest[0]);
        if (limit === undefined) {
          return;
        }
        changeSetting(ctx, { thresholdTokens: limit });
        return;
      }

      notify(ctx, `unknown argument: ${words.join(" ")}. Usage: ${USAGE}`, "error");
    },
  });
}
