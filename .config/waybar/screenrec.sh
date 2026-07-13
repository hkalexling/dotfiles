#!/bin/bash
# Waybar module: shows a pulsing red "● REC mm:ss" while wf-recorder is running.
# State is read from the pidfile written by ~/.config/hypr/scripts/record-toggle.sh
PIDFILE="/tmp/hypr-screenrecord.pid"
OUTFILE="${PIDFILE}.out"

recording=0
if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE" 2>/dev/null)
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        recording=1
    fi
fi

if [ "$recording" -eq 1 ]; then
    ELAPSED=$(ps -o etimes= -p "$PID" 2>/dev/null | tr -d '[:space:]')
    if [ -n "$ELAPSED" ] && [ "$ELAPSED" -ge 3600 ]; then
        TIME=$(date -u -d "@$ELAPSED" '+%H:%M:%S')
    elif [ -n "$ELAPSED" ]; then
        TIME=$(date -u -d "@$ELAPSED" '+%M:%S')
    else
        TIME="??:??"
    fi

    TOOLTIP="Screen recording in progress"
    if [ -f "$OUTFILE" ]; then
        TOOLTIP="Recording → $(cat "$OUTFILE" 2>/dev/null)"
    fi

    printf '{"text":"\u25cf REC %s","class":"recording","tooltip":"%s"}\n' "$TIME" "$TOOLTIP"
    exit 0
fi

# Idle: emit empty text so the module collapses (invisible against the bar).
printf '{"text":"","class":"idle"}\n'
