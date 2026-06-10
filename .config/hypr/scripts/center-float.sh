#!/bin/bash

WIN="$(hyprctl activewindow -j)"

FLOATING="$(echo "$WIN" | jq -r '.floating')"
ADDR="$(echo "$WIN" | jq -r '.address')"

if [[ "$FLOATING" == "true" ]]; then
	hyprctl dispatch togglefloating
	exit 0
fi

CUR_H="$(echo "$WIN" | jq -r '.size[1]')"

TARGET_W=720

hyprctl dispatch togglefloating
hyprctl dispatch resizewindowpixel exact "$TARGET_W" "$CUR_H","address:$ADDR"
hyprctl dispatch centerwindow
