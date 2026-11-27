/**
 * Pure helpers for the herdr-subagents extension.
 *
 * No pi imports, no I/O at module scope, so this file can be imported by plain
 * Node tests (node --test with type stripping) as well as by index.ts through
 * jiti.
 */

export interface AgentFrontmatter {
  description?: string;
  model?: string;
  thinking?: string;
  tools?: string;
  promptMode?: "append" | "replace";
  inheritContext?: boolean;
}

export interface ParsedAgent {
  frontmatter: AgentFrontmatter;
  body: string;
}

export interface BuiltinAgent {
  description: string;
  tools?: string;
  prompt?: string;
  promptMode?: "append" | "replace";
}

/**
 * Built-in worker types. "Read-only" is prompt-level only: `--tools` is a name
 * allowlist and `bash` is on it, so these prompts are advisory, not a sandbox.
 */
export const BUILTIN_AGENTS: Record<string, BuiltinAgent> = {
  "general-purpose": {
    description:
      "General-purpose agent for complex, multi-step tasks (inherits the project system prompt)",
  },
  Explore: {
    description: "Fast codebase exploration agent (read-only by instruction only)",
    tools: "read,bash,grep,find,ls",
    promptMode: "append",
    prompt:
      "You are a read-only codebase exploration agent. Never create, modify, delete, move, or copy files; never write to files via redirects, heredocs, or pipes. Use Bash ONLY for read-only operations such as ls, git status, git log, git diff, find, cat, head, tail; prefer the read, grep, and find tools for searching. Investigate and report findings concisely with absolute file paths and line numbers.",
  },
  Plan: {
    description: "Software architect for implementation planning (read-only by instruction only)",
    tools: "read,bash,grep,find,ls",
    promptMode: "append",
    prompt:
      "You are a software architect. Read-only: never create, modify, delete, move, or copy files; never write to files via redirects, heredocs, or pipes. Use Bash ONLY for read-only operations; prefer the read, grep, and find tools. Produce a concrete implementation plan: files to change, ordered steps, risks, dependencies, and test strategy. Use absolute paths and end with the 3-5 most critical files.",
  },
};

export const MAX_SUMMARY_CHARS = 4000;

/** `w` followed by the first 12 alphanumerics of the parent session ID. */
export function workerSessionTag(sessionId: string): string {
  const clean = String(sessionId)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return `w${clean.slice(0, 12)}`;
}

/** Accept names created before and after the session tag moved to the end. */
export function workerLabel(name: string | undefined, sessionTag: string): string | undefined {
  if (!name || !sessionTag) return undefined;
  const suffix = `-${sessionTag}`;
  if (name.endsWith(suffix) && name.length > suffix.length) {
    return name.slice(0, -suffix.length);
  }
  const prefix = `${sessionTag}-`;
  if (name.startsWith(prefix) && name.length > prefix.length) {
    return name.slice(prefix.length);
  }
  return undefined;
}

/** Session UUID from a session JSONL path (`<timestamp>_<uuid>.jsonl`). */
export function sessionIdFromPath(filePath: string): string {
  const base = String(filePath).split(/[\\/]/).pop() || "";
  return base.replace(/\.jsonl$/, "").replace(/^[^_]*_/, "");
}

/** `provider/model` reference for a pi Model, as accepted by `pi --model`. */
export function modelRef(
  model: { id?: string; provider?: string } | null | undefined,
): string | undefined {
  if (!model || !model.id) {
    return undefined;
  }
  const id = String(model.id);
  if (id.includes("/")) {
    return id;
  }
  return model.provider ? `${model.provider}/${id}` : id;
}

export interface HerdrAgent {
  name?: string;
  agent?: string;
  pane_id?: string;
  tab_id?: string;
  agent_status?: string;
  agent_session?: { value?: string };
}

export interface WorkerTreeEntry {
  agent: HerdrAgent;
  depth: number;
}

/**
 * Collect this session's worker tree from a `herdr agent list` snapshot:
 * direct workers match the session tag. Each worker's session ID identifies
 * its own children. Returned deepest-first so a caller
 * can close children before parents.
 */
export function collectWorkerTree(
  agents: HerdrAgent[],
  sessionTag: string,
): WorkerTreeEntry[] {
  const isWorker = (a: HerdrAgent | null | undefined): a is HerdrAgent =>
    !!a && typeof a.name === "string" && a.name.length > 0 && (!a.agent || a.agent === "pi");
  const byName = new Map<string, HerdrAgent>();
  for (const a of agents) {
    if (isWorker(a)) {
      byName.set(a.name as string, a);
    }
  }
  const found = new Map<string, WorkerTreeEntry>();
  let frontier = agents.filter((a) => isWorker(a) && workerLabel(a.name, sessionTag));
  let depth = 0;
  while (frontier.length) {
    const next: HerdrAgent[] = [];
    for (const a of frontier) {
      const name = a.name as string;
      if (found.has(name)) {
        continue;
      }
      found.set(name, { agent: a, depth });
      const sessionPath = a.agent_session && a.agent_session.value;
      if (!sessionPath) {
        continue;
      }
      const childTag = workerSessionTag(sessionIdFromPath(sessionPath));
      for (const b of byName.values()) {
        if (workerLabel(b.name, childTag) && !found.has(b.name as string)) {
          next.push(b);
        }
      }
    }
    frontier = next;
    depth += 1;
  }
  return [...found.values()].sort((a, b) => b.depth - a.depth);
}

export function slugify(input: string, max = 18): string {
  const s = String(input)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return (s || "worker").slice(0, max).replace(/[-_]+$/, "") || "worker";
}

/** Keep the name within 32 chars and start it with a letter for classic Herdr. */
export function uniqueWorkerName(
  sessionTag: string,
  base: string,
  existing: Iterable<string>,
): string {
  const taken = new Set(existing);
  const slug = slugify(base);
  const label = /^[a-z]/.test(slug) ? slug : slugify(`worker-${slug}`);
  let name = `${label}-${sessionTag}`;
  for (let i = 2; taken.has(name); i++) {
    const counter = `-${i}`;
    name = `${slugify(label, 18 - counter.length)}${counter}-${sessionTag}`;
  }
  return name;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse the frontmatter of a pi-subagents-style agent markdown file.
 * Unknown keys (for example `max_turns`) are ignored.
 */
export function parseAgentMarkdown(text: string): ParsedAgent {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text));
  if (!m) {
    return { frontmatter: {}, body: String(text).trim() };
  }
  const frontmatter: AgentFrontmatter = {};
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const idx = line.indexOf(":");
    if (idx < 0) {
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = unquote(line.slice(idx + 1).trim());
    switch (key) {
      case "description":
        frontmatter.description = value;
        break;
      case "model":
        frontmatter.model = value;
        break;
      case "thinking":
        frontmatter.thinking = value;
        break;
      case "tools":
        frontmatter.tools = value;
        break;
      case "prompt_mode":
        frontmatter.promptMode = value === "replace" ? "replace" : "append";
        break;
      case "inherit_context":
        frontmatter.inheritContext = /^(true|yes|1)$/i.test(value);
        break;
      default:
        break;
    }
  }
  return { frontmatter, body: (m[2] || "").trim() };
}

export function findBuiltinAgent(name: string): BuiltinAgent | null {
  const lowered = String(name).toLowerCase();
  for (const [key, value] of Object.entries(BUILTIN_AGENTS)) {
    if (key.toLowerCase() === lowered) {
      return value;
    }
  }
  return null;
}

export interface JsonSubagentConfig {
  defaultModel?: string;
  defaultThinking?: string;
  agent?: { model?: string; thinking?: string };
}

export interface SpawnOverrides {
  model?: string;
  thinking?: string;
  tools?: string;
  systemPrompt?: string;
  promptMode?: "append" | "replace";
  inheritContext?: boolean;
}

export interface ResolvedSpawnConfig {
  agent: string;
  description?: string;
  model?: string;
  thinking?: string;
  tools?: string;
  systemPrompt?: string;
  promptMode: "append" | "replace";
  inheritContext: boolean;
}

/**
 * Precedence: explicit tool args -> subagents.json agents.<name> ->
 * subagents.json defaults -> agent .md frontmatter -> parent model/thinking.
 */
export function resolveSpawnConfig(input: {
  agent?: string;
  overrides?: SpawnOverrides;
  json?: JsonSubagentConfig;
  custom?: ParsedAgent | null;
  parentModel?: string;
  parentThinking?: string;
}): ResolvedSpawnConfig | { error: string } {
  const agent = input.agent && input.agent.trim() ? input.agent.trim() : "general-purpose";
  const builtin = findBuiltinAgent(agent);
  const custom = input.custom || null;
  if (!builtin && !custom) {
    const known = Object.keys(BUILTIN_AGENTS).join(", ");
    return {
      error: `Unknown agent type "${agent}". Built-ins: ${known}. Custom types come from .pi/agents/<name>.md or the global agents dir.`,
    };
  }
  const overrides = input.overrides || {};
  const json = input.json || {};
  const fm = custom ? custom.frontmatter : {};

  const model =
    overrides.model ||
    json.agent?.model ||
    json.defaultModel ||
    fm.model ||
    input.parentModel ||
    undefined;
  const thinking =
    overrides.thinking ||
    json.agent?.thinking ||
    json.defaultThinking ||
    fm.thinking ||
    input.parentThinking ||
    undefined;
  const tools = overrides.tools ?? fm.tools ?? builtin?.tools;
  const body = custom ? custom.body.trim() : "";
  const systemPrompt = (overrides.systemPrompt ?? body ?? "") || builtin?.prompt || undefined;
  const promptMode = overrides.promptMode ?? fm.promptMode ?? builtin?.promptMode ?? "append";
  const inheritContext = overrides.inheritContext ?? fm.inheritContext ?? false;

  return {
    agent,
    description: (custom && custom.frontmatter.description) || builtin?.description,
    model,
    thinking,
    tools,
    systemPrompt: systemPrompt && systemPrompt.trim() ? systemPrompt.trim() : undefined,
    promptMode,
    inheritContext,
  };
}

/** Translate resolved config to pi CLI flags (before `--name`). */
export function buildPiFlags(
  cfg: ResolvedSpawnConfig,
  opts: { forkSession?: string } = {},
): string[] {
  const flags: string[] = [];
  if (cfg.model) {
    flags.push("--model", cfg.model);
  }
  if (cfg.thinking) {
    flags.push("--thinking", cfg.thinking);
  }
  if (cfg.tools) {
    if (cfg.tools === "none") {
      flags.push("--no-tools");
    } else {
      flags.push("--tools", cfg.tools);
    }
  }
  if (cfg.systemPrompt) {
    flags.push(
      cfg.promptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
      cfg.systemPrompt,
    );
  }
  if (cfg.inheritContext && opts.forkSession) {
    flags.push("--fork", opts.forkSession);
  }
  return flags;
}

export interface SessionEntry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    usage?: Record<string, unknown>;
    stopReason?: string;
  };
}

/** Parse JSONL lines, skipping blank/corrupt lines (tail-boundary partials). */
export function parseJsonlEntries(lines: Iterable<string>): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const line of lines) {
    const t = String(line).trim();
    if (!t) {
      continue;
    }
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === "object") {
        entries.push(parsed as SessionEntry);
      }
    } catch {
      // partial line at the tail boundary
    }
  }
  return entries;
}

export interface LastTurnResult {
  summary: string | null;
  usage: Record<string, unknown> | null;
  lastTextAt: string | null;
  stopReason: string | null;
}

/**
 * Extract the final assistant text of the latest run: only assistant text
 * produced after the last user message counts, so a run that ended on tool
 * calls (abort, limit, crash) reports no text instead of a stale earlier round.
 */
export function extractLastTurn(entries: SessionEntry[]): LastTurnResult {
  let lastUser = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e && e.type === "message" && e.message && e.message.role === "user") {
      lastUser = i;
    }
  }
  let summary: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let lastTextAt: string | null = null;
  let stopReason: string | null = null;
  for (let i = lastUser + 1; i < entries.length; i++) {
    const e = entries[i];
    if (!e || e.type !== "message" || !e.message) {
      continue;
    }
    const m = e.message;
    if (m.role !== "assistant") {
      continue;
    }
    if (m.usage) {
      usage = m.usage;
    }
    if (m.stopReason) {
      stopReason = m.stopReason;
    }
    const parts = Array.isArray(m.content) ? m.content : [];
    const text = parts
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (text) {
      summary = text;
      lastTextAt = e.timestamp || null;
    }
  }
  return { summary, usage, lastTextAt, stopReason };
}

export function capText(text: string, max = MAX_SUMMARY_CHARS): string {
  const s = String(text);
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars — read the transcript for the full text]`;
}

export function describeUsage(usage: Record<string, unknown> | null | undefined): string {
  if (!usage) {
    return "usage: ?";
  }
  const costObj = usage.cost as { total?: number } | undefined;
  const cost = costObj && costObj.total != null ? costObj.total.toFixed(4) : "?";
  return `usage: input=${usage.input ?? "?"} output=${usage.output ?? "?"} total=${usage.totalTokens ?? "?"} cost=${cost}`;
}

// ------------------------------------------------- subagent cleanup nudges

/** A notification queued while a self-compaction is pending. */
export interface HeldNotification<T> {
  name: string;
  message: T;
}

/**
 * Collapse a held-notification queue to the newest entry per worker, preserving
 * first-seen order. Older entries are stale: the worker ran again before the
 * hold was released.
 */
export function latestHeldPerWorker<T>(
  queue: readonly HeldNotification<T>[],
): HeldNotification<T>[] {
  const latest = new Map<string, HeldNotification<T>>();
  for (const item of queue) {
    latest.set(item.name, item);
  }
  return [...latest.values()];
}

/**
 * One-line cleanup hint appended to a settle notification, or null when no
 * other worker is settled. Full names, because `close` needs them verbatim.
 */
export function formatCleanupLine(
  names: readonly string[],
  max = 5,
): string | null {
  if (!names.length) {
    return null;
  }
  const shown = names.slice(0, max).join(", ");
  const more = names.length > max ? `, +${names.length - max} more` : "";
  return (
    `  <cleanup open="${names.length}">${shown}${more} — close any you will ` +
    `not prompt again: subagent({action:"close", id:"…"})</cleanup>`
  );
}

/** One-time hint appended to a consumed worker result (read/wait/foreground). */
export function closeNudgeText(name: string): string {
  return (
    `next: close this worker when you will not prompt it again — ` +
    `subagent({action:"close", id:"${name}"}). Keep it open to continue the ` +
    `same session with a follow-up (e.g. re-review after fixes).`
  );
}

// ------------------------------------------- cross-extension settle hold

export interface HoldControllerOptions<T> {
  /** Deliver one held notification. Errors are swallowed. */
  send: (message: T) => void;
  /** TTL when an event carries no positive `ttlMs`. Default 120_000 ms. */
  defaultTtlMs?: number;
  /** Queue cap before the oldest notification is dropped. Default 50. */
  maxQueue?: number;
}

export interface HoldController<T> {
  /** Handle a `self-compaction:hold` payload. */
  onEvent: (data: unknown) => void;
  /** Queue a notification; true when it was held (the caller must not send). */
  push: (item: HeldNotification<T>) => boolean;
  /** Drop the hold and its queue without delivering. */
  drop: () => void;
  holding: () => boolean;
  queued: () => number;
}

/**
 * Hold notifications while another extension is mid-compaction.
 *
 * A follow-up notification delivered while the parent is streaming keeps its
 * run alive (`hasQueuedMessages()`), so `agent_settled` never fires — and the
 * self-compaction extension only dispatches from `agent_settled`. Holding here
 * lets the run settle; `send` is then called with each notification (the
 * caller delivers them as plain entries, with no wake-up).
 *
 * The TTL is a backstop: a lost `{on:false}` (reload, aborted navigation) must
 * not starve notifications forever.
 */
export function createHoldController<T>(
  options: HoldControllerOptions<T>,
): HoldController<T> {
  const defaultTtlMs = options.defaultTtlMs ?? 120_000;
  const maxQueue = options.maxQueue ?? 50;
  let hold: { id: unknown; since: number; queue: HeldNotification<T>[] } | null =
    null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function flush(h: typeof hold) {
    clearTimer();
    if (!h || !h.queue.length) {
      return;
    }
    for (const item of latestHeldPerWorker(h.queue)) {
      try {
        options.send(item.message);
      } catch {
        // a failing delivery must not wedge the hold
      }
    }
  }

  function arm(ttlMs: number) {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      const h = hold;
      hold = null;
      flush(h);
    }, ttlMs);
    if (timer && typeof timer === "object" && timer.unref) {
      timer.unref();
    }
  }

  return {
    onEvent(data) {
      if (!data || typeof data !== "object") {
        return;
      }
      const event = data as { on?: unknown; id?: unknown; ttlMs?: unknown };
      if (event.on) {
        if (!hold) {
          hold = { id: event.id, since: Date.now(), queue: [] };
        }
        const ttl = Number(event.ttlMs);
        arm(Number.isFinite(ttl) && ttl > 0 ? ttl : defaultTtlMs);
        return;
      }
      const h = hold;
      hold = null;
      flush(h);
    },
    push(item) {
      if (!hold) {
        return false;
      }
      hold.queue.push(item);
      if (hold.queue.length > maxQueue) {
        hold.queue.shift();
      }
      return true;
    },
    drop() {
      clearTimer();
      hold = null;
    },
    holding() {
      return hold !== null;
    },
    queued() {
      return hold ? hold.queue.length : 0;
    },
  };
}

// ----------------------------------- inbound-message wait interruptions

/** Collapse an inbound message into one short line for a tool result. */
export function normalizeMessagePreview(text: unknown, max = 160): string {
  if (typeof text !== "string") {
    return "";
  }
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) {
    return "";
  }
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 1))}…`;
}

export interface MessageInterruptOptions {
  /** Preview cap per message. Default 160 characters. */
  maxPreviewChars?: number;
  /** Queue cap, so a burst of steering cannot arm unbounded releases. */
  maxTokens?: number;
  /** How long a token stays valid. Default 10_000 ms. */
  tokenTtlMs?: number;
  /** Clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface MessageInterruptHit {
  preview: string;
}

export interface MessageInterruptController {
  /** Record one input event; only mid-run steering input arms a release. */
  observe: (input: { streamingBehavior?: unknown; text?: unknown }) => void;
  /** True when an observed steer has not been claimed yet. */
  armed: () => boolean;
  /** Claim one token, oldest preview first; null when none are left. */
  consume: () => MessageInterruptHit | null;
  /** Forget everything, e.g. when a new run starts. */
  reset: () => void;
  tokens: () => number;
}

/**
 * Tokens for inbound messages that may release a blocking tool call.
 *
 * pi drains queued steering input only once the current assistant message's
 * whole tool-call batch has finished, so a tool call that blocks forever hides
 * inbound messages until it returns. Waiters release when they see one — the
 * message then lands with the tool result, in the same run.
 *
 * Only `streamingBehavior === "steer"` arms a token. A queued follow-up is not
 * delivered at the tool boundary, so releasing for one shows the caller nothing
 * and would make every later wait return instantly. Extension-authored custom
 * messages (worker notifications) never reach the `input` event, so they cannot
 * release a wait either; a waiter that has been released still gets its result
 * through the normal settle notification.
 *
 * The `input` event fires before pi enqueues the message, so tokens are only
 * half the gate: callers must also see `ctx.hasPendingMessages()`, which proves
 * the enqueue happened and the boundary drain will pick the message up.
 *
 * A token also expires (`tokenTtlMs`). If pi ever counts queued follow-ups in
 * `hasPendingMessages()`, a token left over from an earlier delivery would keep
 * releasing waits for a message that the tool boundary cannot deliver; the TTL
 * turns that into one bounded hiccup instead of a permanent state.
 */
export function createMessageInterruptController(
  options: MessageInterruptOptions = {},
): MessageInterruptController {
  const maxPreviewChars = options.maxPreviewChars ?? 160;
  const maxTokens = options.maxTokens ?? 16;
  const tokenTtlMs = options.tokenTtlMs ?? 10_000;
  const now = options.now ?? Date.now;
  const tokens: { at: number; preview: string }[] = [];

  function prune() {
    const cutoff = now() - tokenTtlMs;
    while (tokens.length && tokens[0].at <= cutoff) {
      tokens.shift();
    }
  }

  return {
    observe({ streamingBehavior, text }) {
      if (streamingBehavior !== "steer") {
        return;
      }
      prune();
      tokens.push({
        at: now(),
        // A steer with no usable text still arms a release; only the preview is lost.
        preview: normalizeMessagePreview(text, maxPreviewChars),
      });
      if (tokens.length > maxTokens) {
        tokens.shift();
      }
    },
    armed() {
      prune();
      return tokens.length > 0;
    },
    consume() {
      prune();
      if (!tokens.length) {
        return null;
      }
      return { preview: tokens.shift().preview };
    },
    reset() {
      tokens.length = 0;
    },
    tokens() {
      prune();
      return tokens.length;
    },
  };
}
