# X11-only Packages (safe to remove once committed to Hyprland)

| Package | What it does | Wayland replacement |
|---|---|---|
| `arandr` | X11 display config GUI | `nwg-displays` or hyprctl |
| `autorandr` | Auto-detect X11 monitors | Not needed (hyprctl) |
| `ffcast` | Screenshot/cast via ffmpeg X11 | `grim` + `slurp` + `wf-recorder` |
| `gcolor2` | GTK2 color picker | `hyprpicker` |
| `libinput-gestures` | X11 touchpad gestures | Hyprland built-in |
| `lxappearance` | GTK theme switcher X11 | `nwg-look` |
| `lxinput` | LXDE input config | Not needed |
| `nitrogen` | X11 wallpaper | `hyprpaper` |
| `pasystray` | X11 PulseAudio tray | Waybar pulseaudio + media keys |
| `peek` | X11 screen recorder | `wf-recorder` |
| `polkit-gnome` | X11 polkit agent | `hyprpolkitagent` |
| `python-i3ipc` | i3 IPC library | Not needed |
| `redshift` | X11 screen temperature | Not needed |
| `sbxkb` | X11 keyboard layout indicator | Not needed (fcitx5) |
| `volumeicon` | X11 volume tray icon | Waybar pulseaudio |
| `xautolock` | X11 auto-locker | `hypridle` |
| `xcursor-chameleon-pearl` | X11 cursor theme | Hyprcursor env var |
| `xcursor-maia` | X11 cursor theme | Hyprcursor env var |
| `xfce4-power-manager` | X11 power manager | systemd-logind |
| `xidlehook` | X11 idle hook | `hypridle` |
| `xrectsel` | X11 rectangle selector | `slurp` |
| `xorg-xkill` | X11 kill window | Hyprland `killactive` |
| `hexchat` | X11 IRC client | CLI or web alternative |
| `python-keyboard` | X11 global keyboard hook | Not needed |

## AUR

| Package | What it does | Wayland replacement |
|---|---|---|
| `deepin-wayland` | Deepin Wayland session | Not needed |
| `dtkwm` | Deepin Toolkit WM (X11) | Not needed |
| `qt5-styleplugins` | Qt5 style plugins (X11) | Not needed |

---

## Keep as fallback (don't remove)

| Package | Reason |
|---|---|
| `i3-wm`, `i3status-manjaro` | i3 fallback |
| `xorg-server`, `xorg-xinit` | X11 fallback chain |
| `xf86-video-*`, `xf86-input-*` | Xorg drivers for fallback |
| `lightdm`, `lightdm-settings` | Fallback DM |
| `conky` | Still used in Hyprland via Wayland mode |
