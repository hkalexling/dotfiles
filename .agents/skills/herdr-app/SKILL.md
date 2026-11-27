---
name: herdr-app
description: Operate the Herdr desktop app and Herdr Core (`hc`). Use for Core terminals and agents, desktop spaces and focus, waking or hibernating desktop spaces headlessly, or importing classic workspaces into the desktop picker. Use the herdr-tui skill for classic TUI control.
---

# Herdr App and Core

Follow the target the user names. The classic `herdr` server and `hc` are separate. An agent in the classic TUI can operate Core from the same shell. `HERDR_ENV=1` identifies a classic pane, and `HC_TERMINAL_ID` identifies a calling Core terminal. Use discovered IDs from the chosen backend.

- Use `hc --skill` and `hc <command> --help` for terminal and agent operations. `hc ls --json` inventories terminals. Use `hc get <terminal> --json`, `hc read <terminal>`, and `hc wait <terminal>` to inspect and monitor an explicit target. Core terminal addresses look like `t7` or `machine/t7`. A locally started Core and named sessions can have the same terminal IDs, so check `HC_SESSION`, `HC_SOCKET`, and `hc server status` if the target is unclear.
- Use `herdr-app --skill` for desktop layout, windows, or focus. Read `herdr-app ls` for the running window's space, tab, and pane IDs, and `herdr-app commands` for argument names. Use `herdr-app do` with an explicit target for requested UI changes.

## Hibernated desktop spaces

The local `herdr-hibernate` helper works with the selected Core, including when the desktop app is closed. If it is absent from PATH, check `~/.local/bin/herdr-hibernate`.

1. Run `herdr-hibernate list`. Match the space using its name, folder, or tabs. Disambiguate duplicates and use the returned `.spaces[].id`.
2. For a requested wake, run `herdr-hibernate wake <space-id>`. It restores the space and starts agents from their saved Pi or Codex references. Check the result for warnings and verify the resulting terminals with `hc ls --json`.
3. If the user also wants desktop focus and the window is open, use `herdr-app do space.select --id <space-id>`. Ctrl+Shift+R opens **Wake hibernated space** in the desktop app. It is also searchable in the Ctrl+Shift+P command palette.
4. For a requested hibernation, find the live local space ID via `herdr-app ls` or the `herdr-app` layout document via the read-only Core `doc.get` RPC. Run `herdr-hibernate hibernate <space-id>`. This stops the space's terminals after saving their layout and session references. If the helper rejects a busy or unverifiable pane, report the reason. The desktop shortcut is Ctrl+Shift+H, also available as **Hibernate current space** in the command palette.

For a requested deletion, match the hibernated space in `herdr-hibernate list` and run `herdr-hibernate delete <space-id>`. This removes its saved layout. In the wake picker, Ctrl+D on the selected space opens a confirmation.

For a requested migration, `herdr-hibernate import-classic` previews existing hibernated TUI snapshots. `herdr-hibernate import-classic --live` previews classic workspaces from inside the classic TUI. Add `--apply` to copy the intended source into Core's hibernation picker. Imported copies start hibernated. If an original agent still has a conversation open in the TUI, coordinate its exit before waking that conversation in Core.

For boot or session capture diagnosis, see `~/.config/herdr-app/helpers/herdr-app-hibernate/README.md` and `journalctl --user -u herdr-app-hibernate.service`. The helper restores the last-used space on a cold boot. Pi records its session file through an extension. Fresh Codex sessions use the trusted `herdr-hibernate hook codex` entry in `/hooks`; the app's Codex launcher uses `--no-daemon` to keep terminal identity distinct.
