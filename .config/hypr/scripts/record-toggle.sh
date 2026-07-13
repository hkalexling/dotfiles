#!/bin/bash
PIDFILE="/tmp/hypr-screenrecord.pid"

if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE")
    if kill -0 "$PID" 2>/dev/null; then
        kill -INT "$PID" 2>/dev/null
        pkill -INT -P "$PID" 2>/dev/null
        rm -f "$PIDFILE" "$PIDFILE".out
        notify-send -t 3000 "Recording stopped"
        exit 0
    fi
    rm -f "$PIDFILE" "$PIDFILE".out
fi

mkdir -p ~/Videos
OUT="$HOME/Videos/rec_$(date '+%Y%m%d_%H%M%S').mp4"
wf-recorder -g "$(slurp)" -f "$OUT" &
echo $! > "$PIDFILE"
echo -n "$OUT" > "$PIDFILE".out
echo -n "$OUT" | wl-copy
notify-send -t 3000 "Recording started"
