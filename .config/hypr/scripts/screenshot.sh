#!/bin/bash
mkdir -p ~/Pictures/screenshots
F=~/Pictures/screenshots/screenshot_$(date +%Y%m%d_%H%M%S).png
grim -g "$(slurp)" "$F" && echo -n "$F" | wl-copy && notify-send -t 3000 "Screenshot saved"
