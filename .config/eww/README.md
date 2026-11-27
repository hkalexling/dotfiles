# Nano desktop system monitor

This replaces the Conky widget on Nano. It uses a native Wayland layer surface, prefers the external display when docked, and falls back to the built-in panel. The transparent widget keeps the date, CPU governor and usage, top CPU and memory processes, swap, disk, uptime, and kernel. The old NordVPN status line is omitted because Nano doesn't have NordVPN installed.

The user unit expects a Wayland-enabled Eww at `~/.local/bin/eww` and uses Python 3 for stats. The Eww executable is not part of yadm. Hyprland starts `nano-sysmon.service` at login; don't enable it outside the graphical session. For logs, run `journalctl --user -u nano-sysmon.service`.
