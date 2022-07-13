#! /bin/bash

choice="$1"

if [[ -z "$choice" ]]; then
	options="cpu.sh resolution.sh mount.sh system.sh"
	choice=$(echo -e "$options" | awk '{gsub(/ /, "\n")}1' | rofi -dmenu -show run -lines 4 -opacity 85 -bw 0 -width 30 -padding 20 -i -p "Choose a utility script")
fi

~/.i3/$choice
