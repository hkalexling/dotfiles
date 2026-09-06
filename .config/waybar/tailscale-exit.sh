#!/bin/bash
# Waybar module: show active Tailscale exit node, hide when none.
# Hides by emitting empty text (waybar collapses the module).
# Deps: tailscale, jq

set -o pipefail

JSON=$(tailscale status --json 2>/dev/null) || {
    printf '{"text":"","class":"inactive","tooltip":"Tailscale not running"}\n'
    exit 0
}

# ExitNodeStatus is null/absent when no exit node is in use.
EXIT_ID=$(echo "$JSON" | jq -r '.ExitNodeStatus.ID // empty' 2>/dev/null)

if [ -z "$EXIT_ID" ]; then
    printf '{"text":"","class":"inactive","tooltip":"No exit node"}\n'
    exit 0
fi

# Look up peer by ID to get human-readable name/IPs.
PEER=$(echo "$JSON" | jq --arg id "$EXIT_ID" '.Peer[] | select(.ID == $id) // empty' 2>/dev/null)

if [ -n "$PEER" ] && [ "$PEER" != "null" ]; then
    NAME=$(echo "$PEER" | jq -r '.HostName // empty')
    DNS=$(echo "$PEER" | jq -r '.DNSName // empty')
    IP=$(echo "$PEER" | jq -r '.TailscaleIPs[0] // empty')
    ONLINE=$(echo "$PEER" | jq -r '.Online // false')
    RELAY=$(echo "$PEER" | jq -r '.Relay // empty')
    CURADDR=$(echo "$PEER" | jq -r '.CurAddr // empty')
else
    NAME="$EXIT_ID"
    DNS=""
    IP=""
    ONLINE="unknown"
    RELAY=""
    CURADDR=""
fi

[ -z "$NAME" ] && NAME="$EXIT_ID"
# Trim trailing dot from DNSName
DNS=${DNS%.}

# Choose class for styling
if [ "$ONLINE" = "true" ]; then
    CLASS="active"
elif [ "$ONLINE" = "false" ]; then
    CLASS="offline"
else
    CLASS="active"
fi

# Icon — right arrow indicating exit routing.
ICON="→"

TEXT="$ICON $NAME"

# Build tooltip with details
TOOLTIP="Exit node: $NAME"
[ -n "$DNS" ] && TOOLTIP="$TOOLTIP ($DNS)"
[ -n "$IP" ] && TOOLTIP="$TOOLTIP — $IP"
if [ -n "$CURADDR" ]; then
    TOOLTIP="$TOOLTIP — direct $CURADDR"
elif [ -n "$RELAY" ]; then
    TOOLTIP="$TOOLTIP — relay $RELAY"
fi
[ "$ONLINE" = "false" ] && TOOLTIP="$TOOLTIP (offline)"

# Use jq to safely emit JSON (handles escaping)
jq -cn --arg text "$TEXT" --arg tooltip "$TOOLTIP" --arg class "$CLASS" \
    '{text: $text, tooltip: $tooltip, class: $class}'
