#! /bin/bash

set -e

governors="$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors)"
choice="$1"

if [[ -z "$choice" ]]; then
	options="powersave performance"
	choice=$(echo -e "$options" | awk '{gsub(/ /, "\n")}1' | rofi -dmenu -show run -lines 4 -opacity 85 -bw 0 -width 30 -padding 20 -i -p "Choose a governor")
fi

[[ -z "$(echo "$governors" | grep -w "$choice")" ]] && echo "unknown policy $choice" && exit 1

# Thanks ChatGPT
temp_script=$(mktemp)
cat > "$temp_script" <<- EOM
#!/bin/sh
choice="$choice"
for num in 0 1 2 3 4 5 6 7; do
  echo "\$choice" > /sys/devices/system/cpu/cpu\${num}/cpufreq/scaling_governor
done
EOM
chmod +x "$temp_script"
pkexec "$temp_script"
rm -f "$temp_script"
