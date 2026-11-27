/**
 * Pure session-state logic for the session-autocompact extension.
 *
 * No Pi imports, so plain `node --test` can import this file directly.
 *
 * Semantics
 * ---------
 * The setting is *session scoped*, never branch scoped:
 *   - Records are durable custom entries (`pi.appendEntry`) carrying
 *     `{ version, sessionId, enabled }`.
 *   - The current value is the LAST valid record for the CURRENT session id in
 *     `sessionManager.getEntries()` (append order). `getBranch()` is
 *     deliberately not used: a record on an abandoned branch is still a record
 *     of the same session, so `/tree` navigation cannot undo a session-wide
 *     choice.
 *   - A record whose `sessionId` differs from the current session is ignored.
 *     `/fork` and `/clone` copy the parent session's entries into a NEW session
 *     file with a NEW session id, so forks and clones start with no setting.
 *   - No record means no session setting: the session follows the effective
 *     global setting, which is what "default off" means with
 *     `compaction.enabled: false` globally.
 *   - `/autocompact off` writes an explicit record, i.e. the session is pinned
 *     off regardless of what the global setting says later.
 *   - `/autocompact limit <tokens>` stores an optional compaction limit: Pi's
 *     native threshold then fires once the context exceeds that many tokens
 *     (or earlier, if the model's own `contextWindow - reserveTokens` is lower).
 *     The limit is independent of on/off: it only matters while compaction is
 *     enabled for the session, whether by this extension or by the settings.
 *   - Every record is a full snapshot (`enabled` + `thresholdTokens`), so the
 *     last valid record alone is the session's state. Version-1 records (no
 *     limit) are still read.
 */

export const COMMAND_NAME = "autocompact";
export const CUSTOM_TYPE = "session-autocompact";
export const STATUS_KEY = "session-autocompact";
export const STATE_VERSION = 2;
export const LEGACY_STATE_VERSION = 1;
export const USAGE = "/autocompact [on [<tokens>]|off|limit <tokens>|limit off|status]";

/** Smallest accepted limit; anything lower would compact on almost every turn. */
export const MIN_THRESHOLD_TOKENS = 1000;

/** Durable record stored in a `custom` session entry. */
export interface SessionAutocompactRecord {
  version: number;
  sessionId: string;
  /** `null`: no on/off choice for this session (follow the settings). Version 1 always has a boolean. */
  enabled: boolean | null;
  /** Session compaction limit in tokens; `null` = none. Absent in version 1. */
  thresholdTokens?: number | null;
}

/** Structural subset of a Pi session entry that state reading needs. */
export interface EntryLike {
  type?: string;
  id?: string;
  customType?: string;
  data?: unknown;
}

/** Preference read from the session, plus diagnostics for the status output. */
export interface PreferenceResult {
  /** `undefined`: no valid record for this session (no session setting). */
  enabled: boolean | undefined;
  /** `undefined`: no session compaction limit. */
  thresholdTokens: number | undefined;
  /** Valid records found for the current session. */
  matches: number;
  /** Entries of our custom type that failed validation. */
  ignored: number;
  /** Valid records belonging to other sessions (parent sessions of forks). */
  foreign: number;
}

/** Everything the status text needs; computed by the extension, formatted here. */
export interface StatusFacts {
  sessionId: string;
  /** `undefined` when this session has no setting of its own. */
  preference: boolean | undefined;
  /** Session compaction limit; `undefined` when none is set. */
  thresholdTokens?: number;
  /** True when Pi's live `getCompactionSettings(model)` was confirmed to apply the limit. */
  thresholdConfirmed?: boolean;
  /** Label of the current model, e.g. `anthropic/claude-opus`. */
  modelLabel?: string;
  /** Current model context window. */
  contextWindow?: number;
  /** Token count at which Pi would compact without the session limit. */
  nativeTriggerTokens?: number;
  /** Token count at which Pi compacts now (with the session limit applied). */
  effectiveTriggerTokens?: number;
  /** `keepRecentTokens` Pi keeps after compacting. */
  keepRecentTokens?: number;
  /** True when the live Pi settings instance was confirmed to report the value. */
  honored: boolean;
  /** True when the implementation-sensitive capture/override path is available. */
  supported: boolean;
  unsupportedReason?: string;
  /** Effective value Pi would use in this session; `undefined` when unreadable. */
  effectiveEnabled?: boolean;
  /** The user's global `compaction.enabled`; `undefined` when unreadable. */
  globalEnabled?: boolean;
  /** A project `compaction.enabled`, only when the project settings define one. */
  projectEnabled?: boolean;
  /** True when at least one settings value could be read. */
  settingsReadable?: boolean;
  /** Count of entries this extension could not interpret. */
  ignoredEntries?: number;
  /** Count of records that belong to other sessions (e.g. a forked parent). */
  foreignEntries?: number;
}

/** Serialize a record for `pi.appendEntry()`. */
export function createRecord(
  sessionId: string,
  enabled: boolean | undefined,
  thresholdTokens?: number,
): SessionAutocompactRecord {
  return {
    version: STATE_VERSION,
    sessionId,
    enabled: enabled ?? null,
    thresholdTokens: thresholdTokens ?? null,
  };
}

export function isValidThresholdTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_THRESHOLD_TOKENS;
}

/**
 * Parse a user-facing token count: `150000`, `150_000`, `150,000`, `150k`,
 * `1.5m`. Returns `undefined` for anything else (including fractions of a token).
 */
export function parseTokenCount(input: string): number | undefined {
  const text = String(input ?? "").trim().toLowerCase().replace(/[_,]/g, "");
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(text);
  if (!match) {
    return undefined;
  }
  const scale = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  const value = Number(match[1]) * scale;
  const rounded = Math.round(value);
  if (!Number.isSafeInteger(rounded) || Math.abs(value - rounded) > 1e-6) {
    return undefined;
  }
  return rounded;
}

/** `150000` -> `150k`, `1500000` -> `1.5M`, `999` -> `999`. */
export function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "unknown";
  }
  const trim = (n: number) => (Math.round(n * 10) / 10).toString();
  if (Math.abs(value) >= 1_000_000) {
    return `${trim(value / 1_000_000)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${trim(value / 1_000)}k`;
  }
  return String(value);
}

/**
 * Validate one custom-entry payload.
 * Accepts a version-1 record (string session id, boolean flag) or a version-2
 * record (string session id, boolean-or-null flag, valid-limit-or-null limit).
 * Returns `null` for anything else. Unknown shapes are ignored rather than
 * trusted, so a format change never silently re-enables compaction.
 */
export function parseRecord(data: unknown): SessionAutocompactRecord | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const raw = data as Record<string, unknown>;
  if (typeof raw.sessionId !== "string" || raw.sessionId.length === 0) {
    return null;
  }
  if (raw.version === LEGACY_STATE_VERSION) {
    if (typeof raw.enabled !== "boolean") {
      return null;
    }
    return { version: LEGACY_STATE_VERSION, sessionId: raw.sessionId, enabled: raw.enabled };
  }
  if (raw.version !== STATE_VERSION) {
    return null;
  }
  if (typeof raw.enabled !== "boolean" && raw.enabled !== null) {
    return null;
  }
  if (raw.thresholdTokens !== null && !isValidThresholdTokens(raw.thresholdTokens)) {
    return null;
  }
  return {
    version: STATE_VERSION,
    sessionId: raw.sessionId,
    enabled: raw.enabled,
    thresholdTokens: raw.thresholdTokens,
  };
}

/** Scan session entries in append order; the last valid record for this session wins. */
export function readSessionPreference(
  entries: readonly EntryLike[],
  sessionId: string,
): PreferenceResult {
  let enabled: boolean | undefined;
  let thresholdTokens: number | undefined;
  let matches = 0;
  let ignored = 0;
  let foreign = 0;

  for (const entry of entries) {
    if (!entry || entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) {
      continue;
    }
    const record = parseRecord(entry.data);
    if (!record) {
      ignored += 1;
      continue;
    }
    if (record.sessionId !== sessionId) {
      foreign += 1;
      continue;
    }
    matches += 1;
    enabled = record.enabled ?? undefined;
    thresholdTokens = record.thresholdTokens ?? undefined;
  }

  return { enabled, thresholdTokens, matches, ignored, foreign };
}

/** Short, human-facing session id for status text. */
export function shortSessionId(sessionId: string): string {
  const id = String(sessionId ?? "").trim();
  if (!id) {
    return "(unknown)";
  }
  return id.length > 8 ? id.slice(0, 8) : id;
}

function valueOrUnknown(value: boolean | undefined): string {
  if (value === true) return "on";
  if (value === false) return "off";
  return "unknown";
}

/** Multi-line `/autocompact status` text. Only reports values that were read. */
export function formatStatusText(facts: StatusFacts): string {
  const id = shortSessionId(facts.sessionId);
  const lines: string[] = [];

  if (facts.preference === true) {
    lines.push(`auto-compact: ON for this session only (${id}) - set by /autocompact on`);
  } else if (facts.preference === false) {
    lines.push(`auto-compact: OFF for this session only (${id}) - pinned by /autocompact off`);
  } else if (facts.effectiveEnabled === true) {
    lines.push(`auto-compact: ON for this session (${id}) - no session setting; the settings enable it`);
  } else if (facts.effectiveEnabled === false) {
    lines.push(`auto-compact: off for this session (${id}) - no session setting; the settings disable it`);
  } else {
    lines.push(`auto-compact: unknown for this session (${id}) - the settings instance could not be read`);
  }

  if (!facts.supported) {
    lines.push(`  unavailable in this Pi build: ${facts.unsupportedReason ?? "unknown reason"}`);
    lines.push("  nothing was changed and no setting was written");
  }

  if (facts.preference !== undefined) {
    lines.push(`  session setting recorded by this extension: ${valueOrUnknown(facts.preference)}`);
    lines.push(`  confirmed with the live Pi settings instance: ${facts.honored ? "yes" : "no"}`);
    if (!facts.honored) {
      lines.push("  WARNING: could not confirm that Pi's scheduler sees this setting");
    }
  }

  lines.push(`  what Pi would use in this session (effective): ${valueOrUnknown(facts.effectiveEnabled)}`);
  lines.push(
    `  global compaction.enabled: ${valueOrUnknown(facts.globalEnabled)} (this command never writes it; other sessions are not affected)`,
  );
  if (facts.projectEnabled !== undefined) {
    lines.push(`  project compaction.enabled: ${valueOrUnknown(facts.projectEnabled)} (project settings file, not written by this command)`);
  }
  if (facts.settingsReadable === false) {
    lines.push("  the settings values above could not be read, so they are reported as unknown rather than guessed");
  }

  if (!facts.supported) {
    return lines.join("\n");
  }

  lines.push(...formatThresholdLines(facts));
  lines.push("  this session keeps its setting across /resume and /reload; new sessions, /fork and /clone start without one");
  if (facts.thresholdTokens === undefined) {
    lines.push("  token budgets (reserveTokens, keepRecentTokens) and per-model overrides are unchanged");
  } else {
    lines.push("  keepRecentTokens and per-model overrides are unchanged; reserveTokens is only ever raised, never lowered");
  }

  if (facts.ignoredEntries) {
    lines.push(`  note: ignored ${facts.ignoredEntries} unrecognized ${CUSTOM_TYPE} entry/entries`);
  }
  if (facts.foreignEntries) {
    lines.push(`  note: skipped ${facts.foreignEntries} record(s) belonging to other sessions (e.g. a forked parent session)`);
  }

  lines.push(`  change it with: ${USAGE}`);
  return lines.join("\n");
}

function modelSuffix(facts: StatusFacts): string {
  if (facts.modelLabel && facts.contextWindow !== undefined) {
    return ` (${facts.modelLabel}, ${formatTokens(facts.contextWindow)} window)`;
  }
  if (facts.modelLabel) {
    return ` (${facts.modelLabel})`;
  }
  return "";
}

/** Status lines describing the compaction limit and the trigger point Pi uses. */
export function formatThresholdLines(facts: StatusFacts): string[] {
  const lines: string[] = [];
  if (facts.thresholdTokens === undefined) {
    lines.push("  compaction limit: none for this session - Pi uses the model's context window minus reserveTokens");
  } else {
    lines.push(`  compaction limit for this session: ${formatTokens(facts.thresholdTokens)} tokens (${facts.thresholdTokens})`);
    if (facts.contextWindow === undefined) {
      lines.push("  the current model reports no context window, so the limit is not applied until one does");
    } else if (facts.thresholdConfirmed === false) {
      lines.push("  WARNING: could not confirm that Pi's threshold check sees this limit");
    } else if (facts.nativeTriggerTokens !== undefined && facts.thresholdTokens >= facts.nativeTriggerTokens) {
      lines.push(
        `  note: the limit is at or above the model's native trigger (${formatTokens(facts.nativeTriggerTokens)}), so it has no effect with this model`,
      );
    }
    if (facts.keepRecentTokens !== undefined && facts.thresholdTokens <= facts.keepRecentTokens * 2) {
      lines.push(
        `  note: the limit is close to keepRecentTokens (${formatTokens(facts.keepRecentTokens)}); compaction may repeat quickly`,
      );
    }
  }
  if (facts.effectiveTriggerTokens !== undefined) {
    lines.push(`  Pi compacts once context exceeds: ${formatTokens(facts.effectiveTriggerTokens)} tokens${modelSuffix(facts)}`);
  } else if (facts.modelLabel !== undefined || facts.contextWindow !== undefined) {
    lines.push(`  Pi's compaction trigger for the current model: unknown${modelSuffix(facts)}`);
  }
  return lines;
}

/** Feedback for a successful limit change. */
export function formatThresholdChangeText(facts: StatusFacts): string {
  const lines: string[] = [];
  if (facts.thresholdTokens === undefined) {
    lines.push("auto-compact limit cleared for this session: Pi uses the model's context window minus reserveTokens again.");
  } else {
    lines.push(
      `auto-compact limit set for this session: Pi's native scheduler compacts once context exceeds ${formatTokens(facts.thresholdTokens)} tokens.`,
    );
  }
  const effectiveEnabled = facts.preference ?? facts.effectiveEnabled;
  if (effectiveEnabled !== true) {
    lines.push("Auto-compaction is currently off for this session; the limit applies once it is on (/autocompact on).");
  }
  lines.push(...formatThresholdLines(facts).map((line) => line.trimStart()));
  lines.push(`Nothing was compacted now; only this session (${shortSessionId(facts.sessionId)}) is affected.`);
  return lines.join("\n");
}

/** Feedback for a successful on/off change. */
export function formatChangeText(facts: StatusFacts, honored: boolean): string {
  const lines: string[] = [];
  if (facts.preference === true) {
    lines.push("auto-compact ON for this session only: Pi's native scheduler is allowed for this session from the next context check.");
    if (facts.thresholdTokens === undefined) {
      lines.push("Nothing was compacted now; thresholds and model overrides are unchanged.");
    } else {
      lines.push(`Nothing was compacted now; compaction limit for this session: ${formatTokens(facts.thresholdTokens)} tokens.`);
    }
  } else {
    lines.push("auto-compact OFF for this session only: this session stays off even if the global setting changes.");
    lines.push("Manual /compact still works.");
  }
  if (facts.effectiveEnabled !== undefined && facts.preference !== undefined && facts.effectiveEnabled !== facts.preference) {
    lines.push(`WARNING: Pi reports the effective value as ${valueOrUnknown(facts.effectiveEnabled)}; check /autocompact status.`);
  }
  lines.push(
    `global compaction.enabled stays ${valueOrUnknown(facts.globalEnabled)}; only this session (${shortSessionId(facts.sessionId)}) is affected.`,
  );
  if (!honored) {
    lines.push("WARNING: Pi did not confirm the setting; check /autocompact status.");
  }
  return lines.join("\n");
}

/** Footer status text, or `undefined` to clear it. Status is shown when enabled. */
export function formatFooterText(facts: StatusFacts): string | undefined {
  if (facts.preference === true) {
    const limit = facts.thresholdTokens !== undefined ? ` @ ${formatTokens(facts.thresholdTokens)}` : "";
    return facts.honored ? `auto-compact: on${limit} (this session)` : `auto-compact: on${limit} (unconfirmed)`;
  }
  // Off, unset, or unsupported builds get no permanent footer text; the startup
  // notice and `/autocompact status` carry that information instead.
  return undefined;
}
