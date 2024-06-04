#! /bin/bash

set -e

OPTIONS="LAPTOP MONITOR BOTH"

if [ -z "$1" ]; then
	echo "Usage: $0 $OPTIONS"
	exit 1
fi

if [ "$1" == "LAPTOP" ]; then
	xrandr --output eDP-1 --mode 1680x1050 --rate 60 --primary
elif [ "$1" == "MONITOR" ]; then
	xrandr --output DP-2 --mode 1920x1080 --rate 60 --primary
elif [ "$1" == "BOTH" ]; then
	xrandr --output DP-2 --mode 1920x1080 --rate 60 --primary --output eDP-1 --mode 1680x1050 --rate 60 --right-of DP-2
	echo ""
else
	echo "Usage: $0 $OPTIONS"
	exit 1
fi
