# ADR 0005 — Centralized model/thinking defaults via subagents.json

## Status

Accepted

## Context

Subagent model and thinking level selection currently has two sources:

1. Agent `.md` frontmatter (per-agent type, e.g. Explore hardcodes haiku)
2. `subagent()` tool call params (LLM-specified at call time)

Frontmatter is authoritative — the LLM cannot override a frontmatter-specified model or thinking level through tool params.

Users want a third source: a centralized config file where they can set defaults for **all** subagents spawned by this extension, with optional per-agent overrides. The LLM should still be able to override these defaults via tool params when it deems appropriate.

## Decision

Add three new optional fields to `subagents.json` (the existing layered settings file):

- `defaultModel` — model string for all subagents
- `defaultThinking` — thinking level for all subagents
- `agents` — per-agent overrides (`{ "<name>": { "model"?, "thinking"? } }`)

### Precedence (highest to lowest)

1. `subagent()` tool call params
2. Per-agent override in `subagents.json` (`agents.<name>`)
3. Global default in `subagents.json` (`defaultModel` / `defaultThinking`)
4. Agent `.md` frontmatter / built-in default agent config
5. Parent session model / thinking

### Merge behavior

- **Top-level fields** (`defaultModel`, `defaultThinking`): project overrides global (shallow merge — the existing layered settings pattern).
- **`agents` map**: deep-merged across layers. Project `agents.Explore.thinking` overrides global without wiping global `agents.Explore.model`. Project can also add new agent entries not present in global.

### Error handling

- Invalid model from tool params → surface error to caller
- Invalid model from `subagents.json` → surface error to caller (user explicitly configured it)
- Invalid model from agent frontmatter → silent fallback to parent (existing behavior)
- Invalid thinking level → silently dropped by sanitizer on load

### Save behavior

The `/agents` → Settings menu writes only operational fields (`maxConcurrent`, `defaultMaxTurns`, `graceTurns`) to the **project** file. Hand-edited `defaultModel`, `defaultThinking`, and `agents` fields in the project file are preserved (read-merge-write). The global file is never written by code.

## Consequences

### Positive

- Users can set a global model/thinking for all subagents without editing individual agent `.md` files.
- Overriding built-in defaults (e.g. Explore's hardcoded haiku) becomes trivial.
- The LLM retains the ability to override via tool params when appropriate.
- Existing users without `defaultModel` in their config see no behavior change.

### Negative

- Frontmatter is no longer the sole authority for model/thinking selection. Users updating from an older extension version may need to understand the new precedence.
- The `agents` deep merge adds complexity to the layered settings loader.

### Neutral

- Invalid model strings from `subagents.json` now produce visible errors instead of silent fallback. This is intentional — configuration errors should be visible.
