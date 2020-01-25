#!/usr/bin/env bash

# Terminate already running bar instances
killall -q polybar
# If all your bars have ipc enabled, you can also use
# polybar-msg cmd quit

echo "---" | tee -a /tmp/polybar1.log
polybar bar >> /tmp/polybar.log 2>&1 &

echo "Bars launched..."