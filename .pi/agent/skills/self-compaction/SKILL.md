---
name: self-compaction
description: "Compact your own context with the self_compact tool when the user explicitly asks you to self-compact, free up context, or reduce your context. ONLY on an explicit user request: never do this on your own initiative, and treat high context usage as something to report, not a trigger. Never use /compact."
---

# Self-compaction

**Only on explicit request.** Run this only when the user asks you to compact your own context, free up context, or reduce context (e.g. "self-compact", "compact your context", "free up your context"). If you merely notice context usage is high, **say so and ask** — do not self-compact without the user's go-ahead.

When asked, do **not** use `/compact`: it compacts at a point pi chooses, with no control over where to cut or whether to summarize. Use the `self_compact` tool instead: it moves your session's active leaf back to an anchor you choose, optionally summarizes the work you leave behind, and continues from there. Your context becomes everything up to the anchor plus a branch summary of the abandoned work. Nothing is deleted — the abandoned branch stays in the session file and still appears in `/tree`.

## When to use

- The user explicitly asks you to self-compact or free up context.
- The user asks you to keep working on a long task and wants your context reduced first.
- **Not a trigger:** high context usage, long sessions, or a pending automatic compaction. If you think compaction would help, tell the user what you observe and let them decide.
- Never run `/compact`. Never navigate `/tree` by hand mid-run: **navigation aborts your running turn**.

## How it works

- The model receives only the active branch (root → leaf). Moving the leaf back to an earlier entry drops everything after it from the prompt.
- A **user-message** anchor compacts to just **before** it (that message and everything after it are dropped). Any other anchor compacts to just **after** it.
- `mode: "summarize"` (default) preserves the abandoned work as a `[branch]` summary attached at the new position. `mode: "none"` discards it — only for dead ends. `mode: "custom"` uses your `customInstructions`.
- The tool only *schedules* the compaction: navigation cannot run mid-turn, so it runs when your turn settles, then the extension submits your `continuation` as the first message of your next turn.
- While it is scheduled, wake-ups from other extensions (for example subagent task notifications) are held back and delivered as plain transcript entries after navigation. They cannot keep your run alive or stop the settle from happening.

## Recipe

1. **Pick the anchor.** An integer index or a unique search phrase:
   - **Index**: `0` is the oldest candidate, `-1` the newest, `-2` one before that, and so on. In a branched session prefer negative indices (relative to you) or a search phrase — the oldest entry may sit on an older branch.
   - **Search phrase**: a distinctive phrase from the *target* entry (not from your current request, which is itself a candidate). It must match exactly one candidate.
   - Default `scope: "user"` lists only user messages. `scope: "all"` lists every message/summary entry except system and bookkeeping entries; with `all`, an assistant entry or a branch summary is a useful anchor.
   - Pick the earliest message you are willing to drop (usually the second user message, so the original task stays verbatim).
2. **Call `self_compact`** with `anchor`, `mode`, and a single-line `continuation`. Make the continuation a self-contained instruction to yourself: the branch summary may not carry every detail you need.
3. **Stop working and end your turn immediately.** Any further tool calls land on the abandoned branch and are lost from context.
4. **Next turn:** the continuation arrives with a `Self-compaction complete (…)` prefix. Optionally call `context_usage` to confirm the drop. **Every failure is recoverable:** the extension sends a `Self-compaction failed (…)` message that starts a new turn — nothing was compacted, and you can retry with a better anchor.

## Rules

- **Explicit request only.** Never self-compact autonomously; high context usage is not permission. When in doubt, ask.
- The `continuation` must be a **single line** — the tool rejects embedded newlines.
- The anchor must not be the root/system entry. With `scope: "all"`, index `0` is the first non-system entry, so `0` is fine.
- The anchor must not resolve to your current leaf; navigating there is a no-op and the tool rejects it.
- Summarization is a model call and can take a while. If it fails or is cancelled, the extension closes the navigation cleanly and wakes you with a failure message; retry with a different anchor.
- After compaction the abandoned branch still exists in `/tree`. Do not navigate back into it unless the user asks.
