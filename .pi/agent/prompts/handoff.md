---
description: Write a handoff file for the current agent session
argument-hint: "[label-or-path]"
---
You are writing a handoff file for the work completed in the **current agent session / conversation**.

User-provided label or output path, if any:

`$ARGUMENTS`

## Source of truth

Use the current conversation context as the primary source of truth: what the user asked, what you planned, what you changed, what commands you ran, what failed, what you fixed or worked around, and what verification completed.

Do **not** treat this as a review of recent repository changes. Do **not** start by surveying git status, git diff, logs, commits, or the whole codebase to reconstruct work. The handoff is based on the agent-session context.

You may read files only when needed to:

- confirm an exact file path or filename;
- confirm exact command output that is still available in context only approximately;
- avoid writing incorrect details when the session context is insufficient.

Do not modify implementation code. Only write the handoff Markdown file.

## Choose the handoff file name

Use `$ARGUMENTS` flexibly:

- If it is a Markdown path, write exactly that path.
- If it is a short label, write a project-root Markdown file derived from it, e.g. `HANDOFF_<label>.md` or `<LABEL>_HANDOFF.md`.
- If no argument is supplied, derive a concise filename from the session's main task, e.g. `PYTHON_BACKEND_PHASE5_HANDOFF.md`.
- If no useful task label is inferable, use `SESSION_HANDOFF.md`.
- If the chosen file already exists and clearly refers to the same handoff, overwrite it. Otherwise choose a distinct filename.

In your final response, report only the file path written and a brief confirmation.

## Required handoff content

Write a clear Markdown handoff that a future agent or engineer can use to continue the work without needing the full conversation transcript.

Include these sections when applicable:

```markdown
# <Task / Feature> Handoff

## Summary

<What was accomplished and why.>

## User request

<Briefly restate the user's goal and constraints.>

## Work completed

<Concrete bullets of implemented or completed work.>

## Files created

| File | Purpose |
|---|---|
| `<path>` | <purpose> |

If none, say "None".

## Files modified

| File | Changes |
|---|---|
| `<path>` | <summary of changes> |

If none, say "None".

## Steps taken

1. <Step in order>
2. <Step in order>

## Issues encountered and resolutions

### <Issue title>

- Problem: <what went wrong>
- Resolution / workaround: <what you did>
- Status: <resolved / open / partially resolved>

If no issues were encountered, say "No notable issues encountered." Do not invent issues.

## Verification performed

- `<command or manual check>` → <result>

If a check was not run, say that explicitly and why.

## Current status

<Done / partially done / blocked, plus concise details.>

## Follow-ups / open items

- <Any remaining work, risks, or future-phase notes>

If none, say "None known." 
```

## Writing rules

- Be specific and concrete. Include exact file paths where known.
- Distinguish facts from assumptions.
- Do not claim verification was performed unless it happened in this session.
- Include failed commands/tests and their fixes when relevant.
- Mention credentials, external services, or manual verification only when they were part of the session; avoid exposing secrets unless the user explicitly asked to record them.
- Keep the handoff concise but complete enough for continuation.
- After writing the file, give a short final response with the path.
