---
name: subagent
description: "Spawn and manage Pi subagents with the subagent tool. Use when the user asks to delegate or run a worker from Pi in Herdr App/Core or classic Herdr TUI."
---

# Subagent

Delegate work to Pi workers with the `subagent` tool. Each worker has its own context window, tools, model, and session. Herdr App lists workers under their parent terminal. Classic Herdr opens separate tabs in the parent workspace. Headless Core supports the same tool.

Workers launched with `leaf: true` do their tasks directly and report to their parent. In classic Herdr (`HERDR_ENV=1`), `manual.md` provides a shell fallback when the extension is unavailable. In App/Core (`HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET`), use `hc --skill` for manual delegation. Manually launched Core terminals use Core's own messaging and wait commands.

## When to delegate

- Parallelizable exploration, review, or research; isolated context; long-running tasks that should not block you.
- Keep the critical path yourself; delegate bounded, self-contained work.
- Write self-contained prompts: goal, working directory, constraints, what to report back, and end with "finish with a concise final summary and stop".

## Tool actions

| Action | What it does |
| --- | --- |
| `spawn` | Starts Pi, sends the task, and returns a worker ID. With `background: true` (default), you get a notification when the worker settles. `background: false` waits and returns the result inline; it releases early if a message arrives for you. |
| `prompt` | Steers a running worker or continues a settled one (same session, full context). `wait: true` blocks until it settles and releases early if a message arrives for you. |
| `wait` | Blocks until a tracked worker settles (escape hatch; a timeout never kills the worker). Releases early if a message arrives for you — see Notes. |
| `status` | Lists tracked workers with state and terminal or pane ID. |
| `read` | Returns the latest turn's final assistant text, usage, stop reason, and transcript path. |
| `close` | Closes the worker's terminal. Refuses while its own nested workers are active unless `force: true`. |
| `clear` | Closes every worker this session spawned, including nested descendants. Use when the user asks to clean up all subagents. |
| `interrupt` | Sends Esc to abort the current run; the worker stays alive. |

Notes:

- Give each worker a short, task-specific `label`, such as `auth-fix`. The tool appends the parent Pi session tag to make a name such as `auth-fix-w0123456789ab`. Use the returned worker ID for follow-ups.
- `spawn` resolves model/thinking in code: explicit args → `~/.pi/agent/subagents.json` (`agents.<name>`, then `defaultModel`/`defaultThinking`) → custom `.pi/agents/<name>.md` frontmatter → your model. Built-in types: `general-purpose` (default), `Explore`, `Plan`. "Read-only" types are prompt-level only — `bash` is still allowed, so they can mutate state.
- `read`/notifications report only assistant text produced after the last user message, so a run that died on tool calls reports no text instead of a stale earlier answer.
- `prompt` on a settled worker continues the same session (probe history and decisions included). That is continuity, not independence — spawn a fresh worker for an independent verification pass.
- A blocking wait can return early with `interrupted: true` and `incoming: "…"` (empty when the message had no text) because a message arrived for you — from a worker, another agent, or the user. Pi can only deliver queued input once your current tool-call batch ends, so a blocked wait would otherwise sit on it until the timeout. Handle that message, then call `wait` again on the same id: the worker is still running, never re-prompt or re-spawn it, and its result still arrives as a `<task-notification>` if you do not wait again.

## Nesting

- Workers inherit this tool, so nesting is allowed by default (depth cap 2).
- Nested workers notify their own parent, not you; they never appear in your notifications or widget. Each level must fold its children's results into its own summary.
- In Core, a worker ends with its parent terminal. Its saved Pi transcript can still be reopened.
- `leaf: true` makes a worker unable to delegate further (no `subagent` tool; `PI_SUBAGENT_LEAF=1` for the manual fallback). Use it for independent verification, cost control, or deterministic single-pass work.
- Concurrency: default cap of 4 workers per session (raise with `maxConcurrent`). Nesting multiplies it, so make workers leaves when resources matter.

## Cleanup

- Keep a settled worker open when you expect to prompt it again. A reviewer can re-review after you fix its findings, and a worker can take your review comments on its own output: `prompt` continues the same session with full context, which beats spawning a fresh worker for round two.
- Close a worker once its role in the task is finished — you will not prompt it again — or once it has been superseded. Closing ends in-place continuation, but the transcript persists and can be resumed.
- Consumed results, settle notifications, and the system prompt each carry a reminder to close. Don't ignore it: settled workers no longer count against the concurrency cap, so open tabs accumulate silently.
- Close only workers you created.
- The user can run `/subagents` to list this session's workers and `/subagents clear` (or `/clear-subagents`) to close them all with a confirmation prompt.
