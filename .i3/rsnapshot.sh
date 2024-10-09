#!/bin/bash
set -e

timer_name="rsnapshot-hourly.timer"
service_name="rsnapshot@hourly.service"

# Function to stop the service if it's running
stop_service() {
    if systemctl is-active --quiet "$service_name"; then
        echo "Stopping running rsnapshot job..."
        pkexec systemctl stop "$service_name"
        echo "Stopped $service_name"
    else
        echo "No running rsnapshot job found."
    fi
}

# Function to start the timer
start_timer() {
    echo "Starting $timer_name..."
    pkexec systemctl start "$timer_name"
    echo "Started $timer_name"
}

# Function to pause the timer
pause_timer() {
    local hours=$1
    if systemctl is-active --quiet "$timer_name"; then
        pkexec systemctl stop "$timer_name"
        echo "Stopped $timer_name"

        # Calculate resume time
        resume_time=$(date -d "+$hours hour" +"%H:%M %Y-%m-%d")

        # Schedule resume
        echo "pkexec systemctl start $timer_name" | at "$resume_time" 2>/dev/null

        # Confirm actions
        echo "Paused $timer_name for $hours hour(s)."
        echo "Timer will automatically resume at $resume_time"
    else
        echo "$timer_name is already inactive. No action taken."
    fi
}

# Use rofi to get user choice if no argument is provided
choice="$1"
if [[ -z "$choice" ]]; then
    options="pause for 1 hour
pause for 2 hours
start immediately"
    choice=$(echo -e "$options" | rofi -dmenu -i -p "Choose an action")
fi

# Process the choice
case "$choice" in
    "pause for 1 hour")
        stop_service
        pause_timer 1
        ;;
    "pause for 2 hours")
        stop_service
        pause_timer 2
        ;;
    "start immediately")
        stop_service
        start_timer
        ;;
    *)
        echo "Invalid choice. Exiting."
        exit 1
        ;;
esac

# Show timer status
systemctl status "$timer_name" --no-pager

# Show service status
systemctl status "$service_name" --no-pager
