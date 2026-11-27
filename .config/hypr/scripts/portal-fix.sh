#!/bin/sh
# Screen-share repair for Hyprland + xdg-desktop-portal.
#
# Why this exists:
# xdg-desktop-portal picks its backend implementation once, at daemon start-up,
# by matching hyprland.portal's UseIn=wlroots;Hyprland against XDG_CURRENT_DESKTOP
# in its own environment. Hyprland only publishes that variable to the systemd
# user manager when the compositor starts, but user services enabled at login
# (default.target) can D-Bus-activate the portal before that. When they win the
# race, every interface falls back to gtk.portal and there is no
# org.freedesktop.portal.ScreenCast / ...Screenshot on the bus at all:
#   - Chrome's picker opens but "Window"/"Entire Screen" are empty, no OS prompt
#   - Firefox: "Meet needs permission to screen share"
# See the 2026-11-23 breakage (hyprland 0.57 systemd session integration).
#
# This script is a no-op unless that broken state is detected, so it is safe to
# run at every session start.

DESC=/org/freedesktop/portal/desktop
IFACE=org.freedesktop.portal.Desktop

has_screen_cast() {
    busctl --user introspect "$IFACE" "$DESC" 2>/dev/null |
        grep -q 'org\.freedesktop\.portal\.ScreenCast'
}

publish_session_env() {
    VARS="DISPLAY WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE HYPRLAND_INSTANCE_SIGNATURE"
    systemctl --user import-environment $VARS >/dev/null 2>&1
    command -v dbus-update-activation-environment >/dev/null 2>&1 &&
        dbus-update-activation-environment --systemd $VARS >/dev/null 2>&1
}

has_screen_cast && exit 0

# The hyprland backend unit has ConditionEnvironment=WAYLAND_DISPLAY and is
# ordered After=graphical-session.target, so the first attempts can legitimately
# fail while the session target is still being brought up. Retry a few times.
attempts=0
while [ "$attempts" -lt 5 ]; do
    attempts=$((attempts + 1))
    publish_session_env
    systemctl --user start xdg-desktop-portal-hyprland.service >/dev/null 2>&1
    systemctl --user restart xdg-desktop-portal.service >/dev/null 2>&1
    sleep 2
    if has_screen_cast; then
        logger -t portal-fix "restored ScreenCast after $attempts attempt(s)"
        exit 0
    fi
done

logger -t portal-fix "no org.freedesktop.portal.ScreenCast after $attempts attempts"
exit 1
