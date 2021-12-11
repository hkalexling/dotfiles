#!/bin/bash

read -r -d '' options << TXT
logout
suspend
hibernate
shutdown
TXT

choice=$(echo -e "$options" | rofi -dmenu -show run -lines 4 -opacity 85 -bw 0 -width 30 -padding 20 -i -p "Select an action")

[ "$choice" ] || exit

i3exit $choice
