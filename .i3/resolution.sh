#! /bin/bash

choice="$1"

if [[ -z "$choice" ]]; then
	options="2160x1350 1920x1200 1680x1050"
	choice=$(echo -e "$options" | awk '{gsub(/ /, "\n")}1' | rofi -dmenu -show run -lines 4 -opacity 85 -bw 0 -width 30 -padding 20 -i -p "Choose a resolution")
fi

xrandr --output eDP-1 --mode "$choice" --rate 60
nitrogen --restore
~/.i3/conky.sh
