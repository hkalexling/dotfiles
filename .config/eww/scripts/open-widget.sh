#!/bin/sh
# Open the sysmon window once the eww daemon's IPC socket is accepting commands.
# Used as ExecStartPost from ~/.config/systemd/user/eww.service.
set -u

for _ in $(seq 1 50); do
    if eww ping >/dev/null 2>&1; then
        break
    fi
    sleep 0.1
done

exec eww open sysmon
