# Herdr App workspace hibernation

Resume Pi and Codex conversations after a reboot and keep unused local spaces hibernated. This add-on targets Herdr App 0.1.16 and Core 0.1.21 on Linux with systemd.

| Keys | Action |
| --- | --- |
| Ctrl+Shift+H | Save and hibernate the current space |
| Ctrl+Shift+R | Search hibernated spaces by name, folder, or tab and wake one with Enter |
| Ctrl+Shift+P | Open the command palette. Search for **Hibernate current space** or **Wake hibernated space** |

In the wake picker, highlight a space and press **Ctrl+D**, then confirm. For headless use, `herdr-hibernate delete <space-id>` removes the saved layout from the catalog.

The service checkpoints layouts, agent references, and the app's last-used space. On a cold boot it starts that space and leaves the others in the picker. Hibernation stops the workspace's terminals after saving its layout. An active agent or an unrecognized foreground program blocks manual hibernation. Waking restores persistent conversation history and starts ordinary panes as shells.

Verified idle or completed Pi subagents hibernate with their workspace. They resume under their original parent with their saved conversations, names, worktrees, and launch settings.

If a Pi session's working directory has disappeared, the service resumes the same conversation in the space's folder when that folder is available.

## Install

Keep this project in `~/.config/herdr-app/helpers/herdr-app-hibernate/` (under `$XDG_CONFIG_HOME` if set). Open Herdr App once so it writes its shipped command palette. Run `python3 install.py` to preview the paths. Run `python3 install.py --apply` to install the app mods, keybindings, Pi extension, Codex hook, and systemd user service. Previous JSON configuration is backed up in the state directory.

`python3 install.py --entrypoints-only --apply` installs just the regular-file CLI launcher and Pi adapter, and replaces recognized legacy symlinks. Existing desktop commands, the Codex hook, and systemd keep using the same launcher path.

After a Herdr App upgrade, run `python3 install.py --app-only --apply` to rebuild the local palette from the installed app's commands and search behavior.

In a Core-managed Codex terminal, approve the new `herdr-hibernate hook codex` entry in `/hooks`. Fresh Codex chats are recorded once the hook fires. Use the app's Codex launcher or start Codex with `--no-daemon` to keep each hook tied to its terminal. Reopen existing Pi sessions, or use `/reload` in Pi, to load the extension. Sessions need a saved conversation to be resumable.

## Migration

`herdr-hibernate import-classic` previews the classic plugin's parked spaces. Add `--apply` to copy them into the desktop picker. Repeating the import skips snapshots copied previously, even if you have since woken them.

From inside the classic TUI, `herdr-hibernate import-classic --live` previews its open workspaces. Add `--apply` to copy them into the desktop picker as hibernated spaces. The command reads layouts and verified agent references. If an agent's reference is unavailable, that pane will open as a shell when woken. Close a conversation in classic Herdr before waking its copy in the desktop app.

Use `herdr-hibernate list` to inspect the picker catalog and `journalctl --user -u herdr-app-hibernate.service` to inspect boot decisions. To pause the service, run `systemctl --user disable --now herdr-app-hibernate.service`. The app shortcuts and catalog are usable with the service stopped.

## Verification

`python3 tests/integration.py` tests the public Core document and terminal APIs in a private Core. `python3 tests/native_agents.py` tests Pi and Codex against temporary conversation fixtures. The tests simulate a cold boot by stopping the isolated Core and advancing the helper's boot marker. Both leave the regular Core and app state alone.
