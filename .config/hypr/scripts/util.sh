#!/bin/bash

choice="$1"

if [[ -z "$choice" ]]; then
    options="screenshot.sh record-toggle.sh mount.sh conky.sh ocr.sh"
    choice=$(echo "$options" | tr -s ' ' '\n' | rofi -dmenu -show run -lines 8 -opacity 85 -bw 0 -width 30 -padding 20 -i -p "Choose a utility script")
fi

script="$HOME/.config/hypr/scripts/$choice"
if [[ -f "$script" ]]; then
    "$script"
elif [[ -f "$HOME/.i3/$choice" ]]; then
    "$HOME/.i3/$choice"
fi
