---
name: tmux-browser
description: Interact with the user's existing tmux-browser session, including its signed-in tabs, using tmux-browserctl and Chrome DevTools Protocol. Use when the user asks to inspect or operate their browser, a browser tab, or a site in their existing session.
---

# User's tmux-browser

The user's browser is tmux-browser, a Wayland compositor hosting CEF tabs. Its source and current documentation are at `/home/alex_ling/Code/tmp/tmux-browser/README.md`. The browser can expose CDP at `127.0.0.1:9222`, which has been used for this user's running session. Confirm the endpoint is available for the current task rather than assuming it is always enabled.

Prefer a relevant connected app when it can complete the task, unless the user asks to use the browser or the app lacks the needed operation. When using the browser, attach to the existing session so signed-in sites and open tabs are available.

## Discover and target a tab

The installed control binary is `/home/alex_ling/Code/tmp/tmux-browser/target/release/tmux-browserctl`. Use `tmux-browserctl` from `PATH` if available, otherwise that path. Inspect its `--help` or the README when syntax differs.

```sh
/home/alex_ling/Code/tmp/tmux-browser/target/release/tmux-browserctl --json windows
/home/alex_ling/Code/tmp/tmux-browser/target/release/tmux-browserctl --window w1 --json tabs
curl -fsS http://127.0.0.1:9222/json/list | jq '[.[] | select(.type == "page") | {id, title, url}]'
```

Choose the intended tab using its actual window, title and URL. `tmux-browserctl` panel indices are scoped to a window; CDP target IDs are separate identifiers. Avoid relying on the focused tab or matching a page solely by its position. Multiple tabs may have the same title or URL.

Use the control CLI for window and tab operations. For a new background tab in a chosen window use `--window wN open URL --no-focus`. Navigating or closing an existing tab changes the user's session, so select it deliberately and follow the user's instructions. Do not close the browser or unrelated tabs as routine cleanup.

## Inspect and interact with a page

`agent-browser` is installed and can attach to the existing browser via CDP. For its current syntax and snapshot/ref behavior, run `agent-browser skills get core` or `agent-browser --help`. Use a task-specific `--session` consistently.

```sh
agent-browser --session codex-task --cdp 9222 tab list --json
agent-browser --session codex-task --cdp 9222 tab <target-id>
agent-browser --session codex-task --cdp 9222 snapshot -i
agent-browser --session codex-task --cdp 9222 click @e1
```

Select the target ID returned by `tab list`, then inspect the page before acting. Snapshot refs can become stale after page changes; take a fresh snapshot before subsequent interactions. Use screenshots when page layout or rendered content matters. Avoid `agent-browser close` unless its effect on this attached browser is known and authorized.

If the CLI cannot attach or handle a page, use the page-specific `webSocketDebuggerUrl` from `/json/list` with a CDP client. The installed Node.js provides `WebSocket`; connect to the chosen target and use `Runtime.evaluate`, `Input.dispatchMouseEvent`, or other CDP methods as needed. Verify the target's origin and current page before acting. Some interfaces require actual CDP mouse or keyboard events; a DOM click can be ignored or a button can remain disabled until the page receives pointer movement.

CDP permits full control of the signed-in browser. Keep it bound to localhost and avoid exposing authentication material, cookies, page contents, or debugging URLs in logs. Follow the user's authorization for account changes, submissions, messages, and other external actions. If debugging is unavailable, inspect the current browser status and ask for the missing access when required; do not restart the user's browser or create a separate profile without a task reason.
