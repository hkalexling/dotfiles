// Persistence for pi-subagents operational settings.
// - Global:  ~/.pi/agent/subagents.json (agentDir injected at construction) — manual defaults, never written here
// - Project: <cwd>/.pi/subagents.json — written by /agents → Settings; overrides global on load

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "#src/types";
import { type LayeredSettingsSource, loadLayeredSettings } from "#src/layered-settings";

/** Per-agent model/thinking overrides inside subagents.json. */
export interface AgentDefaults {
  model?: string;
  thinking?: ThinkingLevel;
}

export interface SubagentsSettings {
  maxConcurrent?: number;
  /**
   * 0 = unlimited — the extension's single source of truth for that convention:
   * `normalizeMaxTurns()` in turn-limits.ts treats 0 → `undefined`, and the
   * `/agents` → Settings input prompt explicitly says "0 = unlimited".
   */
  defaultMaxTurns?: number;
  graceTurns?: number;
  /** Default model for all subagents. Can be overridden per-agent via `agents`. */
  defaultModel?: string;
  /** Default thinking level for all subagents. Can be overridden per-agent via `agents`. */
  defaultThinking?: ThinkingLevel;
  /** Per-agent model/thinking overrides (keyed by agent name, case-sensitive). */
  agents?: Record<string, AgentDefaults>;
}


/** Emit callback — a subset of `pi.events.emit` to keep helpers testable. */
export type SettingsEmit = (event: string, payload: unknown) => void;

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_GRACE_TURNS = 5;

/** Valid thinking levels for subagents.json validation. */
const VALID_THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh"]);

/**
 * Owns all settings values and their load/save/persist cycle.
 * Separates user-hand-editable "model" fields (defaultModel, defaultThinking, agents)
 * from menu-persisted "operational" fields (maxConcurrent, defaultMaxTurns, graceTurns)
 * to prevent /agents → Settings from wiping hand-edited config.
 */
export class SettingsManager {
  private _defaultMaxTurns: number | undefined = undefined;
  private _graceTurns: number = DEFAULT_GRACE_TURNS;
  private _maxConcurrent: number = DEFAULT_MAX_CONCURRENT;

  // ── Model-think defaults (hand-edited, not touched by menu save) ──
  private _defaultModel: string | undefined = undefined;
  private _defaultThinking: ThinkingLevel | undefined = undefined;
  private _agents: Record<string, AgentDefaults> | undefined = undefined;

  private readonly emit: SettingsEmit;
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly onMaxConcurrentChanged: (() => void) | undefined;

  constructor(deps: { emit: SettingsEmit; cwd: string; agentDir: string; onMaxConcurrentChanged?: () => void }) {
    this.emit = deps.emit;
    this.cwd = deps.cwd;
    this.agentDir = deps.agentDir;
    this.onMaxConcurrentChanged = deps.onMaxConcurrentChanged;
  }

  // ── defaultMaxTurns: 0 or undefined → unlimited (undefined); else max(1, n) ──

  get defaultMaxTurns(): number | undefined {
    return this._defaultMaxTurns;
  }

  set defaultMaxTurns(n: number | undefined) {
    if (n == null || n === 0) {
      this._defaultMaxTurns = undefined;
    } else {
      this._defaultMaxTurns = Math.max(1, n);
    }
  }

  // ── graceTurns: minimum 1 ──

  get graceTurns(): number {
    return this._graceTurns;
  }

  set graceTurns(n: number) {
    this._graceTurns = Math.max(1, n);
  }

  // ── maxConcurrent: minimum 1 ──

  get maxConcurrent(): number {
    return this._maxConcurrent;
  }

  set maxConcurrent(n: number) {
    this._maxConcurrent = Math.max(1, n);
  }

  // ── Model/thinking defaults (hand-edited, never written by menu) ──

  get defaultModel(): string | undefined {
    return this._defaultModel;
  }

  get defaultThinking(): ThinkingLevel | undefined {
    return this._defaultThinking;
  }

  /**
   * Get merged per-agent defaults for a named agent type.
   * Returns global defaults merged with per-agent overrides.
   */
  getAgentDefaults(agentName: string): AgentDefaults {
    const global: AgentDefaults = {};
    if (this._defaultModel) global.model = this._defaultModel;
    if (this._defaultThinking) global.thinking = this._defaultThinking;

    const perAgent = this._agents?.[agentName];
    if (!perAgent) return global;

    return {
      model: perAgent.model ?? global.model,
      thinking: perAgent.thinking ?? global.thinking,
    };
  }

  // ── Lifecycle methods ──

  /**
   * Load merged settings (global + project), apply to in-memory values,
   * and emit the `subagents:settings_loaded` lifecycle event.
   * Returns the raw loaded settings object.
   */
  load(): SubagentsSettings {
    const settings = loadSettings(this.agentDir, this.cwd);
    if (typeof settings.maxConcurrent === "number") this.maxConcurrent = settings.maxConcurrent;
    if (typeof settings.defaultMaxTurns === "number") this.defaultMaxTurns = settings.defaultMaxTurns;
    if (typeof settings.graceTurns === "number") this.graceTurns = settings.graceTurns;
    if (typeof settings.defaultModel === "string") this._defaultModel = settings.defaultModel;
    if (isValidThinking(settings.defaultThinking)) this._defaultThinking = settings.defaultThinking;
    if (settings.agents && typeof settings.agents === "object") this._agents = settings.agents;
    this.emit("subagents:settings_loaded", { settings });
    return settings;
  }

  /**
   * Snapshot current in-memory values for menu persistence.
   * `defaultMaxTurns` uses 0 as the on-disk marker for unlimited (undefined).
   * Does NOT include model/thinking fields — those are hand-edited only.
   */
  snapshot(): { maxConcurrent: number; defaultMaxTurns: number; graceTurns: number } {
    return {
      maxConcurrent: this._maxConcurrent,
      defaultMaxTurns: this._defaultMaxTurns ?? 0,
      graceTurns: this._graceTurns,
    };
  }

  /**
   * Set maxConcurrent, notify interested parties, persist, and return the toast.
   * Owns the full consequence chain so callers just say what they want.
   */
  applyMaxConcurrent(n: number): { message: string; level: "info" | "warning" } {
    this.maxConcurrent = n; // setter normalizes: max(1, n)
    this.onMaxConcurrentChanged?.();
    return this.saveAndNotify(`Max concurrency set to ${this.maxConcurrent}`);
  }

  /**
   * Set defaultMaxTurns, persist, and return the toast.
   * Pass 0 for unlimited (maps to undefined internally).
   */
  applyDefaultMaxTurns(n: number): { message: string; level: "info" | "warning" } {
    this.defaultMaxTurns = n === 0 ? undefined : n; // setter normalizes further
    const label = this.defaultMaxTurns == null ? "unlimited" : String(this.defaultMaxTurns);
    return this.saveAndNotify(`Default max turns set to ${label}`);
  }

  /**
   * Set graceTurns, persist, and return the toast.
   */
  applyGraceTurns(n: number): { message: string; level: "info" | "warning" } {
    this.graceTurns = n; // setter normalizes: max(1, n)
    return this.saveAndNotify(`Grace turns set to ${this.graceTurns}`);
  }

  /**
   * Persist the current snapshot, emit `subagents:settings_changed`,
   * and return the toast the UI should display.
   * Merges menu fields into existing project file to preserve hand-edited fields.
   */
  saveAndNotify(successMsg: string): { message: string; level: "info" | "warning" } {
    const snap = this.snapshot();
    const persisted = saveSettings(snap, this.cwd);
    this.emit("subagents:settings_changed", { settings: snap, persisted });
    return persistToastFor(successMsg, persisted);
  }
}

// Sanity ceilings — prevent hand-edited configs from asking for values that
// make no operational sense (e.g. 1e6 concurrent subagents). Permissive enough
// that any realistic power-user setting passes through.
const MAX_CONCURRENT_CEILING = 1024;
const MAX_TURNS_CEILING = 10_000;
const GRACE_TURNS_CEILING = 1_000;

function isValidThinking(val: unknown): val is ThinkingLevel {
  return typeof val === "string" && VALID_THINKING_LEVELS.has(val);
}

/**
 * Drop fields that don't match the expected shape. Silent — garbage becomes absent.
 */
function sanitize(raw: unknown): SubagentsSettings {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: SubagentsSettings = {};
  if (
    Number.isInteger(r.maxConcurrent) &&
    (r.maxConcurrent as number) >= 1 &&
    (r.maxConcurrent as number) <= MAX_CONCURRENT_CEILING
  ) {
    out.maxConcurrent = r.maxConcurrent as number;
  }
  if (
    Number.isInteger(r.defaultMaxTurns) &&
    (r.defaultMaxTurns as number) >= 0 &&
    (r.defaultMaxTurns as number) <= MAX_TURNS_CEILING
  ) {
    out.defaultMaxTurns = r.defaultMaxTurns as number;
  }
  if (
    Number.isInteger(r.graceTurns) &&
    (r.graceTurns as number) >= 1 &&
    (r.graceTurns as number) <= GRACE_TURNS_CEILING
  ) {
    out.graceTurns = r.graceTurns as number;
  }
  if (typeof r.defaultModel === "string" && r.defaultModel.length > 0) {
    out.defaultModel = r.defaultModel;
  }
  if (isValidThinking(r.defaultThinking)) {
    out.defaultThinking = r.defaultThinking;
  }
  if (r.agents && typeof r.agents === "object" && !Array.isArray(r.agents)) {
    out.agents = sanitizeAgents(r.agents as Record<string, unknown>);
  }
  return out;
}

/** Validate and coerce the agents map. Drops invalid entries silently. */
function sanitizeAgents(raw: Record<string, unknown>): Record<string, AgentDefaults> | undefined {
  const result: Record<string, AgentDefaults> = {};
  let hasValid = false;
  for (const [name, val] of Object.entries(raw)) {
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const entry = val as Record<string, unknown>;
    const agent: AgentDefaults = {};
    if (typeof entry.model === "string" && entry.model.length > 0) agent.model = entry.model;
    if (isValidThinking(entry.thinking)) agent.thinking = entry.thinking;
    if (agent.model || agent.thinking) {
      result[name] = agent;
      hasValid = true;
    }
  }
  return hasValid ? result : undefined;
}

function projectPath(cwd: string): string {
  return join(cwd, ".pi", "subagents.json");
}

/**
 * Load merged settings: global provides defaults, project overrides.
 * Uses deep merge for `agents` so project can override individual agent fields
 * without replacing the entire agents map.
 */
export function loadSettings(agentDir: string, cwd: string): SubagentsSettings {
  const globalPath = join(agentDir, "subagents.json");
  const projectPathVal = projectPath(cwd);

  const globalLayer = readLayer(globalPath, sanitize, "pi-subagents");
  const projectLayer = readLayer(projectPathVal, sanitize, "pi-subagents");

  // Shallow merge for top-level fields, deep merge for agents
  return {
    ...globalLayer,
    ...projectLayer,
    agents: deepMergeAgents(globalLayer.agents, projectLayer.agents),
  };
}

/** Deep-merge two agents maps. Project entries override global per-field. */
function deepMergeAgents(
  globalAgents: Record<string, AgentDefaults> | undefined,
  projectAgents: Record<string, AgentDefaults> | undefined,
): Record<string, AgentDefaults> | undefined {
  if (!globalAgents && !projectAgents) return undefined;
  if (!globalAgents) return projectAgents;
  if (!projectAgents) return globalAgents;

  const merged: Record<string, AgentDefaults> = { ...globalAgents };
  for (const [name, override] of Object.entries(projectAgents)) {
    const existing = merged[name];
    if (existing) {
      merged[name] = { ...existing, ...override };
    } else {
      merged[name] = override;
    }
  }
  return merged;
}

/** Read one settings layer. Missing → `{}` (silent). Malformed → `{}` + warn. */
function readLayer<T>(
  path: string,
  sanitize: (raw: unknown) => Partial<T>,
  warnLabel: string,
): Partial<T> {
  if (!existsSync(path)) return {};
  try {
    return sanitize(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[${warnLabel}] Ignoring malformed settings at ${path}: ${reason}`);
    return {};
  }
}

/**
 * Write project-local settings, preserving non-menu fields from existing file.
 * Global is never touched from code.
 * Returns `true` on success, `false` if the write (or mkdir) failed so the
 * caller can surface a warning — persistence isn't fatal but isn't silent.
 */
export function saveSettings(
  menuFields: { maxConcurrent?: number; defaultMaxTurns?: number; graceTurns?: number },
  cwd: string = process.cwd(),
): boolean {
  const path = projectPath(cwd);
  try {
    // Read existing project file to preserve hand-edited fields
    let existing: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        existing = JSON.parse(readFileSync(path, "utf-8"));
      } catch {
        // Malformed existing file — start fresh
      }
    }

    // Merge menu fields into existing, preserving all other keys
    const merged = { ...existing, ...menuFields };

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(merged, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of `saveSettings` into the right message + level
 * so the UI layer (index.ts) stays a thin wire between input and notification.
 */
export function persistToastFor(
  successMsg: string,
  persisted: boolean,
): { message: string; level: "info" | "warning" } {
  return persisted
    ? { message: successMsg, level: "info" }
    : { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}
