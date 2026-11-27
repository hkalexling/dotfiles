/**
 * The only implementation-sensitive part of the session-autocompact extension.
 *
 * Pi 1.5.2 / 1.6.0 have no public per-session compaction setting:
 *   - `pi.getSettings()` returns a `structuredClone`, so mutating it changes nothing.
 *   - `AgentSession.setAutoCompactionEnabled()` delegates to
 *     `SettingsManager.setCompactionEnabled()`, which writes the GLOBAL setting.
 *   - `SettingsManager.applyOverrides()` is transient: any settings save resets it.
 *   - `ctx.compact()` starts a MANUAL compaction and aborts the active run; it is
 *     not the native scheduler.
 *
 * Workaround used here:
 *   1. briefly wrap `SettingsManager.prototype.getSettings`, call `pi.getSettings()`,
 *      capture `this`, and restore the shared prototype immediately (strictly
 *      synchronous: no `await` while the prototype is wrapped). That reaches the
 *      live settings instance of the current session.
 *   2. install INSTANCE overrides for `getCompactionEnabled` and `getSettings`
 *      that consult a session-local preference. `getCompactionSettings()` calls
 *      `getCompactionEnabled()`, and every native threshold/overflow check calls
 *      `getCompactionSettings(model)`, so the native scheduler honours the
 *      override while token budgets and per-model overrides stay untouched.
 *   2b. optionally install an INSTANCE override for `getCompactionSettings(model)`
 *      that raises `reserveTokens` to `model.contextWindow - limit` when the
 *      session has a compaction limit. Pi's native threshold is
 *      `contextTokens > contextWindow - reserveTokens`, so this moves the native
 *      trigger down to the limit without touching the scheduler itself. The
 *      raised value is `max(native, contextWindow - limit)`, so a limit can only
 *      make compaction earlier, never later than Pi would do anyway.
 *      (In Pi 1.5.2 / 1.6.0 `reserveTokens` from these settings feeds only that
 *      threshold; the summarizer ignores it and the cut point uses
 *      `keepRecentTokens`.)
 *   3. on teardown restore the instance's own property descriptors, reference
 *      counted per attachment and identity guarded so another actor's wrapper
 *      installed after ours is not clobbered.
 *
 * Exception safety: every step pre-checks what it is about to change and any
 * mutation is transactional. A frozen/sealed instance, a non-configurable own
 * method, or a `defineProperty()` that throws yields a `{ ok: false, error }`
 * result with the partial changes and the bookkeeping record rolled back, so no
 * caller has to catch and nothing is left half-installed. `report` carries the
 * one failure that has no return value: a restore that fails during `detach()`.
 *
 * Nothing else in the extension touches Pi internals. Every helper here reports a
 * reason instead of guessing, and none of them write settings.
 */

/** Marker holding the override bookkeeping on the settings instance. */
const RECORD = Symbol.for("pi.session-autocompact.override");

/** Structural view of the settings instance this bridge needs. */
export interface SettingsManagerLike {
  getSettings(): unknown;
  getCompactionEnabled(): boolean;
  getCompactionSettings?: (model?: unknown) => { enabled?: boolean } | undefined;
  getGlobalSettings?: () => unknown;
  getProjectSettings?: () => unknown;
}

export type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Session-local preference. `undefined` means "no session setting; follow the settings". */
export type PreferenceReader = () => boolean | undefined;

/** Session-local compaction limit in tokens. `undefined` means "no session limit". */
export type ThresholdReader = () => number | undefined;

/** Structural view of the model objects Pi passes to `getCompactionSettings(model)`. */
export interface ModelLike {
  contextWindow?: unknown;
  provider?: unknown;
  id?: unknown;
}

/** Shape of `getCompactionSettings()` results the threshold override relies on. */
export interface CompactionSettingsLike {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

export interface AttachmentHandle {
  /** True while this attachment is registered. */
  readonly attached: boolean;
  /** Removes this attachment only. Restores the instance when it was the last one. Idempotent. */
  detach(): void;
}

export interface AttachOptions {
  read: PreferenceReader;
  /** Optional session compaction limit. */
  readThreshold?: ThresholdReader;
  /** Reports problems that cannot reach a return value, i.e. a failed restore during detach(). */
  report?: (message: string) => void;
}

type AnyFunction = (this: unknown, ...args: never[]) => unknown;

/** One attachment: its own token, so the same reader attached twice counts twice. */
interface Attachment {
  token: { seq: number };
  read: PreferenceReader;
  readThreshold?: ThresholdReader;
  report?: (message: string) => void;
}

interface OverrideRecord {
  /** The instance the override is installed on. */
  host: SettingsManagerLike;
  attachments: Attachment[];
  /** The methods that were reachable before we installed anything. */
  baseGetCompactionEnabled: AnyFunction;
  baseGetSettings: AnyFunction;
  baseGetCompactionSettings: AnyFunction;
  /** Own descriptors to put back (undefined = the property was inherited). */
  ownGetCompactionEnabled?: PropertyDescriptor;
  ownGetSettings?: PropertyDescriptor;
  ownGetCompactionSettings?: PropertyDescriptor;
  /** The functions we installed, used for the identity guard on restore. */
  installedGetCompactionEnabled: AnyFunction;
  installedGetSettings: AnyFunction;
  installedGetCompactionSettings: AnyFunction;
}

type InstanceMethodName = "getCompactionEnabled" | "getSettings" | "getCompactionSettings";

const INSTANCE_METHODS: readonly InstanceMethodName[] = ["getCompactionEnabled", "getSettings", "getCompactionSettings"];

let attachmentSeq = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asFunction(value: unknown): AnyFunction | undefined {
  return typeof value === "function" ? (value as AnyFunction) : undefined;
}

function findPropertyDescriptor(target: object, name: string): PropertyDescriptor | undefined {
  for (let current: object | null = target; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      return descriptor;
    }
  }
  return undefined;
}

/** Reason the given value cannot host a session override, or `undefined` when it can. */
export function settingsManagerSupportError(target: unknown, label: string): string | undefined {
  if (typeof target !== "function" && (typeof target !== "object" || target === null)) {
    return `${label} is not available in this Pi build`;
  }
  const holder = typeof target === "function" ? (target as { prototype?: unknown }).prototype : target;
  if (!holder || typeof holder !== "object") {
    return `${label} has no prototype/instance methods in this Pi build`;
  }
  const missing: string[] = [];
  for (const name of ["getSettings", "getCompactionEnabled", "getCompactionSettings"] as const) {
    const descriptor = findPropertyDescriptor(holder as object, name);
    if (!descriptor) {
      missing.push(name);
    } else if (!("value" in descriptor)) {
      missing.push(`${name} (accessor)`);
    } else if (typeof descriptor.value !== "function") {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    return `${label} is missing ${missing.join(", ")}; this extension targets Pi 1.5.x behaviour`;
  }
  return undefined;
}

/** Would installing and later removing both overrides be possible on this object? */
function installabilityError(target: object): string | undefined {
  if (!Object.isExtensible(target)) {
    return "the session settings instance is sealed or frozen, so the session override cannot be added";
  }
  for (const name of INSTANCE_METHODS) {
    const own = Object.getOwnPropertyDescriptor(target, name);
    if (!own) {
      continue;
    }
    if (own.get || own.set) {
      return `the session settings instance has an accessor own ${name}(); the override cannot replace it`;
    }
    if (own.configurable !== true) {
      return `the session settings instance has a non-configurable own ${name}(); the override could not be removed afterwards`;
    }
  }
  return undefined;
}

function recordOf(target: object): OverrideRecord | undefined {
  return (target as Record<symbol, OverrideRecord | undefined>)[RECORD];
}

/** Restore one own property, reporting a problem instead of throwing. */
function restoreOwnProperty(target: object, name: string, descriptor: PropertyDescriptor | undefined): string | undefined {
  try {
    if (descriptor) {
      Object.defineProperty(target, name, descriptor);
    } else {
      delete (target as Record<string, unknown>)[name];
    }
    return undefined;
  } catch (error) {
    return `could not restore ${name}(): ${errorMessage(error)}`;
  }
}

/**
 * Reach the live settings instance of the current session.
 * `read` must call `pi.getSettings()` synchronously and must not await anything.
 * The temporary prototype wrapper is always removed best-effort, and a wrapper
 * that could not be removed is reported instead of left silently in place.
 */
export function captureSettingsManager(
  settingsManagerClass: unknown,
  read: () => unknown,
): BridgeResult<SettingsManagerLike> {
  const classError = settingsManagerSupportError(settingsManagerClass, "SettingsManager");
  if (classError) {
    return { ok: false, error: classError };
  }

  const prototype = (settingsManagerClass as { prototype: object }).prototype;
  const originalDescriptor = Object.getOwnPropertyDescriptor(prototype, "getSettings");
  const originalMethod = asFunction(originalDescriptor?.value);
  if (!originalDescriptor || !originalMethod) {
    return { ok: false, error: "SettingsManager.prototype.getSettings is not a plain method in this Pi build" };
  }

  let captured: unknown;
  const wrapper = function wrapped(this: unknown) {
    captured = this;
    return originalMethod.call(this);
  };

  try {
    Object.defineProperty(prototype, "getSettings", { ...originalDescriptor, value: wrapper });
  } catch (error) {
    return {
      ok: false,
      error: `SettingsManager.prototype.getSettings cannot be wrapped temporarily (${errorMessage(error)}); the session settings instance is not reachable`,
    };
  }

  let readThrew = false;
  let readFailure: unknown;
  try {
    read();
  } catch (error) {
    readThrew = true;
    readFailure = error;
  }

  const restoreProblem = restoreOwnProperty(prototype, "getSettings", originalDescriptor);
  if (restoreProblem) {
    // Best effort: a writable property can also be put back by assignment.
    if (originalDescriptor.writable) {
      try {
        (prototype as Record<string, unknown>).getSettings = originalMethod;
      } catch {
        // Reported below.
      }
    }
    if (Object.getOwnPropertyDescriptor(prototype, "getSettings")?.value !== originalMethod) {
      return {
        ok: false,
        error: `${restoreProblem}; a temporary wrapper was left on SettingsManager.prototype, so this extension stopped trying`,
      };
    }
  }

  if (readThrew) {
    return {
      ok: false,
      error: `pi.getSettings() failed while capturing the live settings instance: ${errorMessage(readFailure)}`,
    };
  }
  if (captured === undefined || captured === null) {
    return {
      ok: false,
      error: "pi.getSettings() never reached SettingsManager.prototype.getSettings; the live settings instance is not reachable",
    };
  }
  const instance = captured as object;
  if (!(instance instanceof (settingsManagerClass as new (...args: never[]) => unknown))) {
    return { ok: false, error: "the settings object reached through getSettings is not an instance of SettingsManager" };
  }
  const manager = instance as SettingsManagerLike;
  const instanceError = settingsManagerSupportError(manager, "the session settings instance");
  if (instanceError) {
    return { ok: false, error: instanceError };
  }
  return { ok: true, value: manager };
}

function readBooleanFlag(settings: unknown, label: string): { value?: boolean; error?: string } {
  if (settings === undefined) {
    return {};
  }
  if (!settings || typeof settings !== "object") {
    return { error: `${label} did not return an object` };
  }
  const compaction = (settings as { compaction?: unknown }).compaction;
  if (compaction === undefined) {
    return {};
  }
  if (!compaction || typeof compaction !== "object") {
    return { error: `${label}.compaction is not an object` };
  }
  const enabled = (compaction as { enabled?: unknown }).enabled;
  if (enabled === undefined) {
    return {};
  }
  if (typeof enabled !== "boolean") {
    return { error: `${label}.compaction.enabled is ${typeof enabled}, not a boolean` };
  }
  return { value: enabled };
}

/** Current value of the global `compaction.enabled`, or `undefined` when unreadable. */
export function globalCompactionEnabled(manager: SettingsManagerLike | undefined): boolean | undefined {
  if (!manager || typeof manager.getGlobalSettings !== "function") {
    return undefined;
  }
  try {
    return readBooleanFlag(manager.getGlobalSettings(), "getGlobalSettings()").value;
  } catch {
    return undefined;
  }
}

/** What the settings instance actually reports right now, or `undefined` where it cannot be read. */
export interface SettingViews {
  /** At least one of the values below was read. */
  readable: boolean;
  /** The effective value for this session, i.e. what Pi's scheduler would use. */
  effective?: boolean;
  /** The user's global `compaction.enabled`. */
  global?: boolean;
  /** A project `compaction.enabled`, only when the project settings define one. */
  project?: boolean;
  problems: string[];
}

export function readSettingViews(manager: SettingsManagerLike | undefined): SettingViews {
  if (!manager) {
    return { readable: false, problems: ["the session settings instance is not reachable"] };
  }
  const problems: string[] = [];
  let effective: boolean | undefined;
  try {
    const value = manager.getCompactionEnabled?.();
    if (typeof value === "boolean") {
      effective = value;
    } else {
      problems.push("getCompactionEnabled() did not return a boolean");
    }
  } catch (error) {
    problems.push(`getCompactionEnabled() threw: ${errorMessage(error)}`);
  }

  let global: boolean | undefined;
  if (typeof manager.getGlobalSettings === "function") {
    try {
      const read = readBooleanFlag(manager.getGlobalSettings(), "getGlobalSettings()");
      global = read.value;
      if (read.error) {
        problems.push(read.error);
      }
    } catch (error) {
      problems.push(`getGlobalSettings() threw: ${errorMessage(error)}`);
    }
  }

  let project: boolean | undefined;
  if (typeof manager.getProjectSettings === "function") {
    try {
      const read = readBooleanFlag(manager.getProjectSettings(), "getProjectSettings()");
      project = read.value;
      if (read.error) {
        problems.push(read.error);
      }
    } catch (error) {
      problems.push(`getProjectSettings() threw: ${errorMessage(error)}`);
    }
  }

  return { readable: effective !== undefined || global !== undefined || project !== undefined, effective, global, project, problems };
}

function effectivePreference(record: OverrideRecord): boolean | undefined {
  for (const attachment of record.attachments) {
    try {
      const value = attachment.read();
      if (typeof value === "boolean") {
        return value;
      }
    } catch {
      // A broken reader must not break Pi's own settings access.
    }
  }
  return undefined;
}

function effectiveThreshold(record: OverrideRecord): number | undefined {
  for (const attachment of record.attachments) {
    if (!attachment.readThreshold) {
      continue;
    }
    try {
      const value = attachment.readThreshold();
      if (isValidThreshold(value)) {
        return value;
      }
    } catch {
      // A broken reader must not break Pi's own settings access.
    }
  }
  return undefined;
}

function isValidThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** The model's context window, or `undefined` when the model does not report a usable one. */
export function contextWindowOf(model: unknown): number | undefined {
  if (!model || typeof model !== "object") {
    return undefined;
  }
  const value = (model as ModelLike).contextWindow;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Raise `reserveTokens` so that Pi's native `contextWindow - reserveTokens`
 * threshold lands at the session limit. Never lowers it; returns `base` itself
 * when nothing changes so that native results pass through untouched.
 */
export function applyCompactionThreshold(base: unknown, model: unknown, threshold: number | undefined): unknown {
  if (threshold === undefined || !base || typeof base !== "object") {
    return base;
  }
  const reserve = (base as CompactionSettingsLike).reserveTokens;
  if (typeof reserve !== "number" || !Number.isFinite(reserve)) {
    return base;
  }
  const window = contextWindowOf(model);
  if (window === undefined) {
    return base;
  }
  const raised = Math.max(reserve, window - threshold);
  if (raised === reserve) {
    return base;
  }
  return { ...(base as Record<string, unknown>), reserveTokens: raised };
}

/** Copy settings and reflect the session-local flag, without mutating the source. */
function withCompactionEnabled(settings: unknown, enabled: boolean): unknown {
  if (!settings || (typeof settings !== "object" && typeof settings !== "function")) {
    return settings;
  }
  let copy: Record<string, unknown>;
  try {
    copy = structuredClone(settings) as Record<string, unknown>;
  } catch {
    // Settings that carry non-cloneable values fall back to a shallow copy.
    copy = { ...(settings as Record<string, unknown>) };
  }
  const compaction =
    copy.compaction && typeof copy.compaction === "object"
      ? { ...(copy.compaction as Record<string, unknown>) }
      : {};
  compaction.enabled = enabled;
  copy.compaction = compaction;
  return copy;
}

function defineInstanceMethod(
  target: object,
  name: InstanceMethodName,
  value: AnyFunction,
  own: PropertyDescriptor | undefined,
): void {
  Object.defineProperty(target, name, {
    value,
    writable: own ? own.writable !== false : true,
    enumerable: own ? own.enumerable === true : false,
    configurable: true,
  });
}

/**
 * Put the instance back the way it was.
 * Identity-guarded: if something else installed a wrapper over ours, that wrapper
 * already captured our methods and still works, so it is left in place.
 */
function restoreOverrideProperties(manager: object, record: OverrideRecord): string[] {
  const problems: string[] = [];
  const pairs: Array<{ name: InstanceMethodName; installed: AnyFunction; own?: PropertyDescriptor }> = [
    {
      name: "getCompactionEnabled",
      installed: record.installedGetCompactionEnabled,
      own: record.ownGetCompactionEnabled,
    },
    {
      name: "getSettings",
      installed: record.installedGetSettings,
      own: record.ownGetSettings,
    },
    {
      name: "getCompactionSettings",
      installed: record.installedGetCompactionSettings,
      own: record.ownGetCompactionSettings,
    },
  ];

  for (const pair of pairs) {
    const current = Object.getOwnPropertyDescriptor(manager, pair.name);
    if (!current || current.value !== pair.installed) {
      continue;
    }
    if (current.get || current.set) {
      continue;
    }
    const problem = restoreOwnProperty(manager, pair.name, pair.own);
    if (problem) {
      problems.push(problem);
    }
  }
  return problems;
}

function clearRecord(manager: object): string[] {
  try {
    delete (manager as unknown as Record<symbol, unknown>)[RECORD];
    return [];
  } catch (error) {
    return [`could not remove the override bookkeeping: ${errorMessage(error)}`];
  }
}

/**
 * Install the session-local override on one settings instance.
 * Each attachment counts separately (even the same reader function twice), and
 * each handle removes exactly its own attachment. When several attachments are
 * registered on one instance, the first one that reports a boolean decides, so a
 * later attachment never silently overrides an earlier session's choice. Every
 * failure returns a reason and leaves the instance exactly as it was.
 */
export function attachSessionCompactionOverride(
  manager: SettingsManagerLike,
  options: AttachOptions,
): BridgeResult<AttachmentHandle> {
  const instanceError = settingsManagerSupportError(manager, "the session settings instance");
  if (instanceError) {
    return { ok: false, error: instanceError };
  }
  if (!options || typeof options.read !== "function") {
    return { ok: false, error: "attachSessionCompactionOverride requires a read() function" };
  }
  if (options.readThreshold !== undefined && typeof options.readThreshold !== "function") {
    return { ok: false, error: "attachSessionCompactionOverride: readThreshold must be a function" };
  }

  const attachment: Attachment = {
    token: { seq: ++attachmentSeq },
    read: options.read,
    readThreshold: options.readThreshold,
    report: options.report,
  };

  const existing = recordOf(manager);
  if (existing) {
    existing.attachments.push(attachment);
    return { ok: true, value: handleFor(existing, attachment) };
  }

  const installError = installabilityError(manager);
  if (installError) {
    return { ok: false, error: installError };
  }

  const baseGetCompactionEnabled = asFunction(manager.getCompactionEnabled);
  const baseGetSettings = asFunction(manager.getSettings);
  const baseGetCompactionSettings = asFunction(manager.getCompactionSettings);
  if (!baseGetCompactionEnabled || !baseGetSettings || !baseGetCompactionSettings) {
    return {
      ok: false,
      error: "the session settings instance does not expose getSettings/getCompactionEnabled/getCompactionSettings as methods",
    };
  }

  const ownGetCompactionEnabled = Object.getOwnPropertyDescriptor(manager, "getCompactionEnabled");
  const ownGetSettings = Object.getOwnPropertyDescriptor(manager, "getSettings");
  const ownGetCompactionSettings = Object.getOwnPropertyDescriptor(manager, "getCompactionSettings");

  const record: OverrideRecord = {
    host: manager,
    attachments: [attachment],
    baseGetCompactionEnabled,
    baseGetSettings,
    baseGetCompactionSettings,
    ownGetCompactionEnabled,
    ownGetSettings,
    ownGetCompactionSettings,
    installedGetCompactionEnabled: function thisGetCompactionEnabled(this: unknown) {
      const value = effectivePreference(record);
      if (value === undefined) {
        return baseGetCompactionEnabled.call(this) as boolean;
      }
      return value;
    },
    installedGetSettings: function thisGetSettings(this: unknown) {
      const base = baseGetSettings.call(this);
      const value = effectivePreference(record);
      if (value === undefined) {
        return base;
      }
      return withCompactionEnabled(base, value);
    },
    installedGetCompactionSettings: function thisGetCompactionSettings(this: unknown, model?: unknown) {
      const base = (baseGetCompactionSettings as (this: unknown, model?: unknown) => unknown).call(this, model);
      return applyCompactionThreshold(base, model, effectiveThreshold(record));
    },
  };

  const installed: InstanceMethodName[] = [];
  try {
    (manager as unknown as Record<symbol, OverrideRecord>)[RECORD] = record;
    defineInstanceMethod(manager, "getCompactionEnabled", record.installedGetCompactionEnabled, ownGetCompactionEnabled);
    installed.push("getCompactionEnabled");
    defineInstanceMethod(manager, "getSettings", record.installedGetSettings, ownGetSettings);
    installed.push("getSettings");
    defineInstanceMethod(
      manager,
      "getCompactionSettings",
      record.installedGetCompactionSettings,
      ownGetCompactionSettings,
    );
    installed.push("getCompactionSettings");
  } catch (error) {
    const problems = [...restoreOverrideProperties(manager, record), ...clearRecord(manager)];
    return {
      ok: false,
      error: `could not install the session override on the settings instance${installed.length ? ` (partially installed ${installed.join(", ")} and rolled back)` : ""}: ${errorMessage(error)}${problems.length ? `; ${problems.join("; ")}` : ""}`,
    };
  }

  return { ok: true, value: handleFor(record, attachment) };
}

function handleFor(record: OverrideRecord, attachment: Attachment): AttachmentHandle {
  let active = true;

  const handle: AttachmentHandle = {
    get attached() {
      return active;
    },
    detach() {
      if (!active) {
        return;
      }
      active = false;
      const index = record.attachments.indexOf(attachment);
      if (index >= 0) {
        record.attachments.splice(index, 1);
      }
      if (record.attachments.length > 0) {
        return;
      }
      const problems = [...restoreOverrideProperties(record.host, record), ...clearRecord(record.host)];
      if (problems.length > 0) {
        attachment.report?.(`could not fully restore the session settings instance: ${problems.join("; ")}`);
      }
    },
  };
  return handle;
}

/** What Pi's threshold check would use for one model, with and without the session limit. */
export interface ThresholdView {
  /** The model's context window, when the model reports one. */
  contextWindow?: number;
  /** `reserveTokens` from the settings alone (no session limit applied). */
  nativeReserveTokens?: number;
  /** `reserveTokens` Pi's scheduler sees right now through the live instance. */
  effectiveReserveTokens?: number;
  /** `keepRecentTokens` Pi would keep after compacting. */
  keepRecentTokens?: number;
  /** Token count above which Pi's threshold check fires: `contextWindow - effectiveReserveTokens`. */
  triggerTokens?: number;
  /** Same as `triggerTokens` without the session limit. */
  nativeTriggerTokens?: number;
  problems: string[];
}

function reserveOf(value: unknown): number | undefined {
  const reserve = (value as CompactionSettingsLike | undefined)?.reserveTokens;
  return typeof reserve === "number" && Number.isFinite(reserve) ? reserve : undefined;
}

function keepRecentOf(value: unknown): number | undefined {
  const keep = (value as CompactionSettingsLike | undefined)?.keepRecentTokens;
  return typeof keep === "number" && Number.isFinite(keep) ? keep : undefined;
}

/** Read the native and effective threshold for `model`. Never throws. */
export function readThresholdView(manager: SettingsManagerLike | undefined, model: unknown): ThresholdView {
  const problems: string[] = [];
  if (!manager) {
    return { problems: ["the session settings instance is not reachable"] };
  }
  const contextWindow = contextWindowOf(model);

  let effective: unknown;
  try {
    effective = manager.getCompactionSettings?.(model);
  } catch (error) {
    problems.push(`getCompactionSettings() threw: ${errorMessage(error)}`);
  }

  let native: unknown = effective;
  const record = recordOf(manager as object);
  if (record) {
    try {
      native = (record.baseGetCompactionSettings as (this: unknown, model?: unknown) => unknown).call(manager, model);
    } catch (error) {
      problems.push(`the native getCompactionSettings() threw: ${errorMessage(error)}`);
      native = undefined;
    }
  }

  const effectiveReserveTokens = reserveOf(effective);
  const nativeReserveTokens = reserveOf(native);
  return {
    contextWindow,
    nativeReserveTokens,
    effectiveReserveTokens,
    keepRecentTokens: keepRecentOf(effective) ?? keepRecentOf(native),
    triggerTokens:
      contextWindow !== undefined && effectiveReserveTokens !== undefined ? contextWindow - effectiveReserveTokens : undefined,
    nativeTriggerTokens:
      contextWindow !== undefined && nativeReserveTokens !== undefined ? contextWindow - nativeReserveTokens : undefined,
    problems,
  };
}

/**
 * Confirm that Pi's `getCompactionSettings(model)` reports the reserve the
 * session limit asks for. Returns `ok: true, confirmed: false` when the model has
 * no context window to confirm against (nothing to apply yet, not a failure).
 */
export function verifySessionCompactionThreshold(
  manager: SettingsManagerLike,
  model: unknown,
  threshold: number | undefined,
): { ok: boolean; confirmed: boolean; error?: string } {
  const view = readThresholdView(manager, model);
  if (view.problems.length > 0) {
    return { ok: false, confirmed: false, error: view.problems.join("; ") };
  }
  if (view.contextWindow === undefined || view.nativeReserveTokens === undefined) {
    return { ok: true, confirmed: false };
  }
  if (view.effectiveReserveTokens === undefined) {
    return { ok: false, confirmed: false, error: "getCompactionSettings().reserveTokens is not a number" };
  }
  const expected =
    threshold === undefined
      ? view.nativeReserveTokens
      : Math.max(view.nativeReserveTokens, view.contextWindow - threshold);
  if (view.effectiveReserveTokens !== expected) {
    return {
      ok: false,
      confirmed: false,
      error: `getCompactionSettings().reserveTokens reported ${view.effectiveReserveTokens}, expected ${expected}`,
    };
  }
  return { ok: true, confirmed: true };
}

/**
 * Confirm the native scheduler actually sees the session value, that the
 * effective settings really report it, and that this did not write the global
 * setting. Call after attaching; this is the assumption breaker. It never
 * reports success when one of the three views could not be read.
 */
export function verifySessionCompactionOverride(
  manager: SettingsManagerLike,
  expected: boolean,
  globalBefore: boolean | undefined,
): { ok: boolean; error?: string } {
  let reported: unknown;
  try {
    reported = manager.getCompactionSettings?.(undefined)?.enabled;
  } catch (error) {
    return { ok: false, error: `getCompactionSettings() threw: ${errorMessage(error)}` };
  }
  if (typeof reported !== "boolean") {
    return { ok: false, error: "getCompactionSettings().enabled did not report the session setting" };
  }
  if (reported !== expected) {
    return { ok: false, error: `getCompactionSettings().enabled reported ${reported}, expected ${expected}` };
  }

  let direct: unknown;
  try {
    direct = manager.getCompactionEnabled();
  } catch (error) {
    return { ok: false, error: `getCompactionEnabled() threw: ${errorMessage(error)}` };
  }
  if (typeof direct !== "boolean") {
    return { ok: false, error: "getCompactionEnabled() did not return a boolean" };
  }
  if (direct !== expected) {
    return { ok: false, error: `getCompactionEnabled() reported ${direct}, expected ${expected}` };
  }

  // Read the effective settings before comparing the global value: a getter could
  // normalize settings as a side effect, and that is exactly what must be caught.
  let settings: unknown;
  try {
    settings = manager.getSettings();
  } catch (error) {
    return { ok: false, error: `getSettings() threw: ${errorMessage(error)}` };
  }
  const read = readBooleanFlag(settings, "getSettings()");
  if (read.error) {
    return { ok: false, error: read.error };
  }
  if (read.value === undefined) {
    return { ok: false, error: "getSettings() does not report compaction.enabled, so the effective settings cannot be confirmed" };
  }
  if (read.value !== expected) {
    return { ok: false, error: `getSettings().compaction.enabled reported ${read.value}, expected ${expected}` };
  }

  const globalNow = globalCompactionEnabled(manager);
  if (globalBefore !== undefined && globalNow !== undefined && globalNow !== globalBefore) {
    return {
      ok: false,
      error: `global compaction.enabled changed from ${globalBefore} to ${globalNow}; this extension must not write global settings`,
    };
  }

  return { ok: true };
}
