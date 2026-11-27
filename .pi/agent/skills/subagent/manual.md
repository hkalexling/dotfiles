# Subagent: pi workers in herdr tabs (manual fallback)

Use this procedure only when the `subagent` tool is **not available** in your toolset (extension disabled or failed to load). It drives the same workers by hand through the `herdr` CLI with the `bash` tool. Notifications are off in this mode (the same extension provides them), so use `herdr agent wait` and read transcripts instead of waiting for a `<task-notification>`.

## Precondition

Verify you are inside a herdr-managed pane:

```bash
test "${HERDR_ENV:-}" = 1 && echo ok
```

If this fails, say you are not running inside herdr and stop. Every command below acts on the current herdr session via `herdr` in `PATH`.

If `$PI_SUBAGENT_LEAF` is `1`, you were spawned as a leaf worker: do not delegate further; do the task yourself and finish with a summary.

## Naming rule (required for notifications)

Use a readable task label followed by the parent Pi session tag.

```bash
SESSION_TAG="w$(printf %s "$PI_SESSION_ID" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9' | cut -c1-12)"
SLUG="auth-fix"
WORKER="${SLUG}-${SESSION_TAG}"
```

The label starts with a lowercase letter and uses up to 18 characters from `a-z`, `0-9`, `_`, and `-`. The full name is at most 32 characters. For a repeated label, place the counter before the tag, as in `auth-fix-2-w0123456789ab`. The extension uses the tag to find workers and send completion notifications. With the extension unavailable, use `herdr agent wait` to collect results.

Shell syntax never matters for notifications: the extension reads herdr state, not your command line. Use pipes, `&&`, variables, whatever is convenient.

## Nesting

Nesting is allowed by default. Workers inherit this skill, your extensions, and herdr's environment (`HERDR_ENV=1` and the socket path are present in every herdr tab), so a worker can spawn its own workers, and the worker's own listener instance notifies it when they finish.

- Nested workers carry their immediate parent's session tag. Each parent sees its own children in the widget and receives their notifications. An intermediary should include its children's results in its final summary.
- To make a worker a leaf, say so in its task prompt: "Do not delegate further — you are a leaf worker." Use this for independent verification, cost control, or deterministic single-pass work.
- Your concurrency budget (~4) covers workers you own directly; nesting multiplies it, so reach for leaf prompts when resources matter.

## Procedure

### 1. Resolve worker configuration

Honor the old pi-subagents config when present (`~/.pi/agent/subagents.json`):

```bash
GLOBAL_MODEL=$(jq -r '.defaultModel // empty' ~/.pi/agent/subagents.json 2>/dev/null)
GLOBAL_THINKING=$(jq -r '.defaultThinking // empty' ~/.pi/agent/subagents.json 2>/dev/null)
# per-agent override example: jq -r '.agents["Explore"].model // empty' ...
```

Precedence for model/thinking: explicit user request → `agents.<name>` in subagents.json → `defaultModel`/`defaultThinking` → agent `.md` frontmatter → parent defaults (`$PI_MODEL`, `$PI_REASONING_LEVEL`).

Built-in worker types (when no custom `.md` exists):

| Type | Flags |
| --- | --- |
| `general-purpose` | none (inherits this project's normal system prompt) |
| `Explore` | `--tools read,bash,grep,find,ls --append-system-prompt "<Explore prompt below>"` |
| `Plan` | `--tools read,bash,grep,find,ls --append-system-prompt "<Plan prompt below>"` |

Built-in read-only prompts (pass verbatim):

- **Explore** — `You are a read-only codebase exploration agent. Never create, modify, delete, move, or copy files; never write to files via redirects, heredocs, or pipes. Use Bash ONLY for read-only operations such as ls, git status, git log, git diff, find, cat, head, tail; prefer the read, grep, and find tools for searching. Investigate and report findings concisely with absolute file paths and line numbers.`
- **Plan** — `You are a software architect. Read-only: never create, modify, delete, move, or copy files; never write to files via redirects, heredocs, or pipes. Use Bash ONLY for read-only operations; prefer the read, grep, and find tools. Produce a concrete implementation plan: files to change, ordered steps, risks, dependencies, and test strategy. Use absolute paths and end with the 3-5 most critical files.`

**Confinement: "read-only" is prompt-level, not enforced.** `--tools` is an allowlist of tool *names*, and `bash` is on it — the worker can still `rm`, `git checkout`, run mutating tests, or write through shell redirection. The built-in types are read-only by instruction only. If you need real confinement:

- drop `bash` (`--tools read,grep,find,ls`) for true read-only, at the cost of git log/diff;
- or run the worker in a throwaway `git worktree` and pass its path as `--cwd`, so writes cannot touch the user's checkout;
- or use a container/sandbox if the user has one;
- and verify afterward (`git status`) when it matters.

Custom agent types come from `.pi/agents/<name>.md` (project) or `$PI_CODING_AGENT_DIR/agents/<name>.md` (global, default `~/.pi/agent/agents/<name>.md`). Translate the frontmatter to pi flags:

| Frontmatter | pi flag |
| --- | --- |
| `model` | `--model <value>` |
| `thinking` | `--thinking <value>` |
| `tools: read,bash,...` | `--tools read,bash,...`; `none` → `--no-tools` |
| `prompt_mode: replace` | `--system-prompt "<body>"` |
| `prompt_mode: append` (default) | `--append-system-prompt "<body>"` |
| `inherit_context: true` | `--fork "$PI_SESSION_FILE"` |

`$PI_SESSION_FILE` is a pi-injected env var in the `bash`/`powershell` tool environment: the absolute path to this session's JSONL file. It is **unset for ephemeral sessions** (`--no-session`), in which case `--fork` is unavailable — guard with `[ -n "$PI_SESSION_FILE" ]`. Frontmatter keys with no pi equivalent (for example `max_turns`) are ignored.

Extract the body (everything after the closing `---` of the frontmatter):

```bash
BODY_FILE=$(mktemp)
python3 - "path/to/agent.md" "$BODY_FILE" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
m = re.match(r"^---\n.*?\n---\n?(.*)$", text, re.S)
open(sys.argv[2], "w").write(m.group(1) if m else text)
PY
```

### 2. Create the tab

```bash
TAB_JSON=$(herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$PWD" \
  --label "pi-worker:$WORKER" --no-focus)
TAB=$(printf %s "$TAB_JSON" | jq -r '.result.tab.tab_id')
PANE=$(printf %s "$TAB_JSON" | jq -r '.result.root_pane.pane_id')
```

`--no-focus` keeps the user's focus where it is. Drop it only if the user asked to switch to the worker.

### 3. Start the worker

```bash
herdr agent start "$WORKER" --kind pi --pane "$PANE" --timeout 90000 -- \
  ${GLOBAL_MODEL:+--model "$GLOBAL_MODEL"} \
  ${GLOBAL_THINKING:+--thinking "$GLOBAL_THINKING"} \
  --name "$WORKER"
```

`--timeout` is in **milliseconds** and bounds only herdr's wait for pi to be detected and ready for input — not the worker's run. Default 30000, max 300000 (5 minutes). Add translated type flags after `--` as needed (`--tools`, `--append-system-prompt "$(cat "$BODY_FILE")"`, `--fork "$PI_SESSION_FILE"`, `--session <path>` for resume). On success the JSON result includes the worker's session path under `.result.agent.agent_session.value`.

**If start fails:** a bad model name, a missing `pi`, and a readiness timeout all look the same from the CLI — it waits the full `--timeout`, then exits 1 with `{"error":{"code":"timeout","message":"timed out waiting for agent startup"}}`, and no agent is registered (`herdr agent get` → `agent_not_found`). The real cause is only in the pane:

```bash
herdr pane read "$PANE" --source recent-unwrapped --lines 40
```

Look for pi's `Model "..." not found` or the shell's `command not found`, fix the cause, close the tab, and retry.

### 4. Send the task

Write a self-contained prompt: goal, working directory, constraints, exactly what to report back. End every task prompt with a final-summary instruction: "When finished, reply with a concise final summary and stop." This guarantees the transcript has a closing assistant message, which result extraction relies on. Add "do not delegate further — you are a leaf worker" only when you want a leaf (see Nesting). For long or structured prompts, write the text to a file and pass it by substitution:

```bash
PROMPT_FILE=$(mktemp)
cat > "$PROMPT_FILE" <<'EOF'
<goal, cwd, constraints, what to report>
When finished, reply with a concise final summary and stop.
EOF
herdr agent prompt "$WORKER" "$(cat "$PROMPT_FILE")"
```

For a foreground wait, use the worker's **literal** name in the command (not `"$WORKER"`): the duplicate-notification suppression matches the literal name plus `--wait` in the command text. The `$(cat ...)` prompt body does not affect that.

**Background (preferred for anything slow or parallel):**

```bash
herdr agent prompt "$WORKER" "$TASK"          # returns after submission
```

Then end your turn if you have nothing else to do, or block with `herdr agent wait` (foreground, or scheduled in the background: `nohup herdr agent wait "$WORKER" > /tmp/wait.log 2>&1 &`) and check back.

Bound a foreground wait with `--timeout` (milliseconds; see step 4 for a value when you need the answer in this turn). `herdr agent wait` blocks indefinitely without it, and while any tool call blocks, input typed into your own pane is held back too: Pi delivers queued input only once the current assistant message's whole tool-call batch has finished. Each return is your chance to pick up what arrived — read it, then wait again.

**Foreground (when you need the answer in this turn):**

```bash
herdr agent prompt auth-fix-w0123456789ab "$TASK" --wait --timeout 600000
```

`--timeout` is milliseconds and bounds only this `--wait` call, not the worker; on expiry it returns `timeout` while the worker keeps running (check it later with `herdr agent wait` or the transcript). Keep it under 15 minutes (900000 ms); longer work belongs in the background.

### 5. Steer, interrupt, inspect

```bash
herdr agent prompt "$WORKER" "Stop and do X instead."   # mid-run steer, delivered after the current tool batch
herdr agent send-keys "$WORKER" esc                     # abort the current run
herdr agent get "$WORKER" | jq -r '.result.agent.agent_status'
herdr agent read "$WORKER" --source recent-unwrapped --lines 120
```

`agent prompt` is rejected while the worker is `blocked` (waiting at an approval/question UI) — inspect with `agent read` and decide before sending input. Herdr may not classify pi as `blocked` reliably; if something looks stuck, read the pane.

### 6. Continue a settled worker

A worker stays alive in its tab after it settles. Prompting it again starts a new turn in the **same session** — it remembers every prior probe, file read, and decision:

```bash
herdr agent prompt auth-fix-w0123456789ab "Round 2: re-review after my fixes. ..." --wait --timeout 600000
```

Use this for iterative refinement (review → fix → re-review, follow-up questions). The transcript path is unchanged, and the listener notifies again on the next settle.

Continuity vs independence: a reused worker is not an independent verification pass — it carries its earlier assumptions. When the point is a genuinely independent check, spawn a **fresh** worker (new tab, new session) and add the leaf instruction.

### 7. Collect the result

- Foreground: `agent prompt --wait` returns agent state JSON, not the reply. Read the reply with the snippet below, or use `herdr agent read`.
- Background: the notification contains a summary, usage, and the transcript path.

The snippet reads only assistant text produced **after the latest user message**, so a run that died on tool calls (abort, limit, crash) reports no text instead of replaying an earlier round:

```bash
SESSION=$(herdr agent get "$WORKER" | jq -r '.result.agent.agent_session.value')
python3 - "$SESSION" <<'PY'
import json, sys
entries = []
for line in open(sys.argv[1]):
    try: entries.append(json.loads(line))
    except Exception: pass
last_user = -1
for i, e in enumerate(entries):
    if e.get("type") == "message" and (e.get("message") or {}).get("role") == "user":
        last_user = i
last, usage, ts = None, None, None
for e in entries[last_user + 1:]:
    if e.get("type") != "message":
        continue
    m = e.get("message") or {}
    if m.get("role") != "assistant":
        continue
    usage = m.get("usage") or usage
    texts = [c.get("text", "") for c in m.get("content", []) if c.get("type") == "text"]
    if any(t.strip() for t in texts):
        last, ts = "\n".join(texts), e.get("timestamp")
if last:
    print(last)
    print("lastTextAt:", ts)
else:
    print("(no assistant text since the last prompt - the run may have ended on tool calls; read the transcript or pane)")
print("usage:", json.dumps(usage) if usage else "?")
PY
```

Terminal fallback: `herdr agent read "$WORKER" --source recent-unwrapped --lines 200`.

### 8. Resume in a new tab (tab closed or agent gone)

Keep the transcript path from step 7. To continue later:

```bash
RESUMED_WORKER="${SLUG:0:16}-2-${SESSION_TAG}"
herdr agent start "$RESUMED_WORKER" --kind pi --pane "$NEW_PANE" -- --session "$SESSION"
herdr agent prompt "$RESUMED_WORKER" "Continue from where you left off: <next step>"
```

The resumed worker keeps the parent session tag at the end of its name. Use step 6 while the original worker is alive.

### 9. Cleanup

Close tabs you created once their result is consumed and the user does not need them. Keep the tab open when the worker's output is evidence the user may want to read (reviews, plans, diffs) and mention it in your report. Closing the tab ends in-place continuation (the transcript file persists; a new tab can resume from it) and does not close workers the worker itself spawned — if nesting was allowed, check `herdr agent list` for still-working descendants before closing.

```bash
herdr tab close "$TAB"
```

Never close tabs you did not create. When in doubt, leave the tab open.

## Rules

- Prefer background workers and block with `herdr agent wait` (backgrounded with `nohup` for long runs); do not busy-poll. Notifications are off in manual mode.
- Budget at most ~4 concurrent workers you own directly unless the user asks for more; nesting multiplies concurrency, so make workers leaves when resources matter.
- All workers inherit your extensions, skills, and project context; they can therefore delegate themselves (see Nesting).
- Long commands: pi's bash tool rejects explicit timeouts over 900 s. For longer waits, run the wait in the background (`nohup herdr agent wait "$WORKER" > /tmp/wait.log 2>&1 &`) and check back, or rely on the completion notification.
- Never leave an unbounded `herdr agent wait` in the foreground: pass a `--timeout` and re-wait. A blocked tool call also holds back messages typed into your own pane, because Pi delivers queued input only at the end of the current tool-call batch. (Step 4's 600000 ms is the ceiling for one bash call, not a suggested default.)
- `herdr agent wait` is turn-agnostic: with an already-working worker it can return on the tail of the previous turn. Trust the session transcript for results, not just state transitions.
- If a worker crashes or exits, `herdr agent get` returns `agent_not_found`; inspect with `herdr agent read` before the pane closes, or read the transcript file.
- This is the manual fallback for the `subagent` tool. If the tool is available, prefer it: it handles naming, config resolution, waits, transcript extraction, and cleanup.
