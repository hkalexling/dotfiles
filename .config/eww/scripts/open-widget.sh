#!/bin/sh
# Wait for Eww's IPC socket before mapping a widget on each active display.
set -eu
config=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
eww=$HOME/.local/bin/eww

for _ in $(seq 1 50); do
    if "$eww" -c "$config" ping >/dev/null 2>&1; then
        # Eww's GDK selector uses model names rather than connector names.
        # Use each screen index exactly once to cover all connected outputs.
        count=$(hyprctl -j monitors | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
        if [ "$count" -gt 0 ]; then
            i=0
            while [ "$i" -lt "$count" ]; do
                "$eww" -c "$config" open sysmon --id "sysmon-$i" --screen "$i"
                i=$((i + 1))
            done
            exit 0
        fi
    fi
    sleep 0.1
done
printf '%s\n' 'Eww or its displays did not become ready' >&2
exit 1
