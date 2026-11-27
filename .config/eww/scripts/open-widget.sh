#!/bin/sh
# Wait for Eww's IPC socket before mapping the monitor widget.
set -eu
config=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
eww=$HOME/.local/bin/eww

for _ in $(seq 1 50); do
    if "$eww" -c "$config" ping >/dev/null 2>&1; then
        exec "$eww" -c "$config" open sysmon
    fi
    sleep 0.1
done
printf '%s\n' 'Eww did not become ready' >&2
exit 1
