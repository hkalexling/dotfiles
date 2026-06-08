#!/bin/bash
mkdir -p ~/Pictures/screenshots
F=~/Pictures/screenshots/screenshot_$(date +%Y%m%d_%H%M%S).png
grim -g "$(slurp)" "$F" && swappy -f "$F" -o "$F" && echo -n "$F" | wl-copy
