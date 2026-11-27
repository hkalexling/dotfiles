/**
 * Pure anchor resolution for the self-compaction extension.
 *
 * No pi imports, so plain `node --test` can import this file directly.
 *
 * Anchor semantics (see SKILL.md and the self_compact tool description):
 *   - scope "user": candidates are the user messages on the active branch,
 *     oldest -> newest.
 *   - scope "all":  candidates are the meaningful entries on the active branch,
 *     oldest -> newest, excluding system messages and bookkeeping entries
 *     (model changes, thinking-level changes, labels, usage, custom entries).
 *   - Positive index: 0 = oldest candidate.
 *   - Negative index: -1 = newest candidate, -2 = one before it, ...
 *   - Search phrase: unique substring of a candidate's text (case-sensitive).
 *     Ambiguous and absent phrases are errors.
 *
 * Navigation semantics (mirrors pi's session.navigateTree):
 *   - A user-message or custom-message target moves the leaf to its PARENT
 *     (the target itself and everything after it are dropped; the target text
 *     would be placed in the editor).
 *   - Any other target moves the leaf TO the target (everything after it is
 *     dropped; the editor stays empty).
 */

export type Scope = "user" | "all";
export type Mode = "none" | "summarize" | "custom";

/** Structural subset of pi's SessionEntry that anchor resolution needs. */
export interface EntryLike {
  id: string;
  parentId: string | null;
  type: string;
  message?: { role?: string; content?: unknown; command?: unknown } | null;
  summary?: string | null;
  content?: unknown;
  customType?: string;
}

export interface AnchorCandidate {
  id: string;
  parentId: string | null;
  /** "user", "assistant", "toolResult", "branch-summary", "custom:<type>", ... */
  kind: string;
  /** Full searchable text of the entry. */
  text: string;
  /** Short one-line display string, e.g. `user: "fix the parser"`. */
  preview: string;
}

export type ResolveResult =
  | { ok: true; candidate: AnchorCandidate; index: number; total: number }
  | { ok: false; error: string };

const PREVIEW_LIMIT = 80;
const HINT_LIMIT = 12;

/** Extract plain text from a message/custom-message content value. */
export function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join("\n");
}

/** The kind label used in previews and candidate hints. */
export function entryKind(entry: EntryLike): string {
  switch (entry.type) {
    case "message":
      return entry.message?.role ?? "message";
    case "custom_message":
      return `custom:${entry.customType ?? "message"}`;
    case "branch_summary":
      return "branch-summary";
    case "compaction":
      return "compaction";
    default:
      return entry.type;
  }
}

/** Full searchable text for an entry (empty when the entry carries no text). */
export function entryText(entry: EntryLike): string {
  switch (entry.type) {
    case "message": {
      const text = contentToText(entry.message?.content);
      const command =
        typeof entry.message?.command === "string" ? entry.message.command : "";
      return command ? `${text}\n${command}` : text;
    }
    case "custom_message":
      return contentToText(entry.content);
    case "branch_summary":
    case "compaction":
      return typeof entry.summary === "string" ? entry.summary : "";
    default:
      return "";
  }
}

/** A short one-line preview for a candidate. */
export function entryPreview(entry: EntryLike): string {
  const kind = entryKind(entry);
  const raw = entryText(entry).replace(/\s+/g, " ").trim();
  if (!raw) {
    return `${kind}: (no text)`;
  }
  const text =
    raw.length > PREVIEW_LIMIT ? `${raw.slice(0, PREVIEW_LIMIT - 1)}…` : raw;
  return `${kind}: ${JSON.stringify(text)}`;
}

function isCandidate(entry: EntryLike, scope: Scope): boolean {
  if (scope === "user") {
    return entry.type === "message" && entry.message?.role === "user";
  }
  // scope "all": meaningful context entries only.
  switch (entry.type) {
    case "message":
      // System messages (and malformed entries without a role) are not targets.
      return (
        typeof entry.message?.role === "string" &&
        entry.message.role !== "system"
      );
    case "custom_message":
    case "branch_summary":
    case "compaction":
      return true;
    default:
      // usage, label, model_change, thinking_level_change, session_info,
      // custom (non-context), context_edit: not meaningful navigation targets.
      return false;
  }
}

/** Candidates on the active branch (root -> leaf), oldest first. */
export function collectCandidates(
  branch: readonly EntryLike[],
  scope: Scope,
): AnchorCandidate[] {
  const candidates: AnchorCandidate[] = [];
  for (const entry of branch) {
    if (!isCandidate(entry, scope)) {
      continue;
    }
    candidates.push({
      id: entry.id,
      parentId: entry.parentId,
      kind: entryKind(entry),
      text: entryText(entry),
      preview: entryPreview(entry),
    });
  }
  return candidates;
}

/** Human-readable candidate list for error messages. */
export function formatCandidates(candidates: readonly AnchorCandidate[]): string {
  if (candidates.length === 0) {
    return "";
  }
  const lines: string[] = [];
  const push = (index: number, candidate: AnchorCandidate) => {
    lines.push(`  [${index}] ${candidate.preview}`);
  };
  if (candidates.length <= HINT_LIMIT) {
    candidates.forEach((candidate, index) => push(index, candidate));
  } else {
    for (let i = 0; i < HINT_LIMIT - 3; i++) {
      push(i, candidates[i]);
    }
    lines.push(`  … ${candidates.length - HINT_LIMIT} more …`);
    for (let i = candidates.length - 3; i < candidates.length; i++) {
      push(i, candidates[i]);
    }
  }
  return `\nCandidates (oldest first):\n${lines.join("\n")}`;
}

/**
 * Resolve an anchor string against the active branch.
 * `anchor` is a decimal index (possibly negative) or a unique search phrase.
 */
export function resolveAnchor(
  branch: readonly EntryLike[],
  anchor: string,
  scope: Scope,
): ResolveResult {
  const candidates = collectCandidates(branch, scope);
  if (candidates.length === 0) {
    return {
      ok: false,
      error: `no candidates on the active branch for scope="${scope}"`,
    };
  }
  const trimmed = anchor.trim();
  if (!trimmed) {
    return { ok: false, error: "anchor is empty" };
  }
  if (/^[+-]?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    const index = n >= 0 ? n : candidates.length + n;
    if (index < 0 || index >= candidates.length) {
      return {
        ok: false,
        error:
          `index ${n} is out of range: the active branch has ${candidates.length} ` +
          `candidate(s) for scope="${scope}"` +
          formatCandidates(candidates),
      };
    }
    return { ok: true, candidate: candidates[index], index, total: candidates.length };
  }
  const matches: Array<{ candidate: AnchorCandidate; index: number }> = [];
  candidates.forEach((candidate, index) => {
    if (candidate.text.includes(trimmed)) {
      matches.push({ candidate, index });
    }
  });
  if (matches.length === 0) {
    return {
      ok: false,
      error:
        `no entry on the active branch matched ${JSON.stringify(trimmed)} ` +
        `(scope="${scope}", ${candidates.length} candidate(s))` +
        formatCandidates(candidates),
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error:
        `ambiguous anchor ${JSON.stringify(trimmed)}: ${matches.length} entries matched ` +
        `(indices ${matches.map((m) => m.index).join(", ")}); use a longer phrase or an index`,
    };
  }
  const match = matches[0];
  return {
    ok: true,
    candidate: match.candidate,
    index: match.index,
    total: candidates.length,
  };
}

/**
 * How many branch entries are abandoned when navigating to `target`.
 * Mirrors pi's navigateTree leaf placement (user/custom-message targets keep
 * everything before them; other targets keep the target itself).
 */
export function countDropped(
  branch: readonly EntryLike[],
  target: EntryLike,
): number {
  const editorTarget =
    target.type === "custom_message" ||
    (target.type === "message" && target.message?.role === "user");
  const newLeafId = editorTarget ? target.parentId : target.id;
  if (newLeafId === null) {
    return branch.length;
  }
  const index = branch.findIndex((entry) => entry.id === newLeafId);
  if (index === -1) {
    return 0;
  }
  return branch.length - index - 1;
}
