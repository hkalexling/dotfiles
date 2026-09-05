-- Hyprland Lua config — migrated from hyprland.conf
-- https://wiki.hypr.land/Configuring/Start/

---@module 'hl'

local mainMod = "ALT"

-- ── General ──────────────────────────────────────────────────────────────────

hl.config({
  input = {
    kb_options = "ctrl:nocaps",
    touchpad = {
      natural_scroll = true,
    },
  },
  general = {
    layout = "scrolling",
  },
  scrolling = {
    column_width = 0.5,
    direction = "right",
  },
  xwayland = {
    force_zero_scaling = true,
    use_nearest_neighbor = true,
  },
})

-- ── Monitor ──────────────────────────────────────────────────────────────────

hl.monitor({
  output = "",
  scale  = 1.25,
  -- cm            = "hdr",
  -- sdrbrightness = 3.0,
  -- sdrsaturation = 1.25,
})

-- ── Environment ──────────────────────────────────────────────────────────────

hl.env("HYPRCURSOR_THEME", "rose-pine-hyprcursor")
hl.env("HYPRCURSOR_SIZE", 30)

-- ── Curves & Animations ─────────────────────────────────────────────────────

hl.config({
  animations = {
    enabled = true,
  },
})

hl.curve("snappy", {
  type   = "bezier",
  points = { { 0.15, 0.75 }, { 0.0, 1.0 } },
})

hl.animation({ leaf = "windows", enabled = true, speed = 3, bezier = "snappy", style = "popin" })
hl.animation({ leaf = "windowsOut", enabled = true, speed = 3, bezier = "snappy", style = "popin" })
hl.animation({ leaf = "windowsMove", enabled = true, speed = 3, bezier = "snappy", style = "slide" })
hl.animation({ leaf = "workspaces", enabled = true, speed = 2, bezier = "snappy", style = "slide" })
hl.animation({ leaf = "border", enabled = true, speed = 3, bezier = "snappy" })
hl.animation({ leaf = "fade", enabled = true, speed = 3, bezier = "snappy" })
hl.animation({ leaf = "layers", enabled = true, speed = 3, bezier = "snappy" })

-- ── Gestures ─────────────────────────────────────────────────────────────────

hl.gesture({
  fingers   = 3,
  direction = "horizontal",
  action    = "scroll_move",
})

-- ── Autostart ────────────────────────────────────────────────────────────────

hl.on("hyprland.start", function()
  hl.exec_cmd("exec /usr/lib/hyprpolkitagent/hyprpolkitagent")
  hl.exec_cmd("waybar")
  hl.exec_cmd("hyprpaper")
  hl.exec_cmd("nm-applet")
  hl.exec_cmd("fcitx5")
  hl.exec_cmd("hypridle")
  hl.exec_cmd("swayosd-server")
  -- Keep Conky in a dedicated user service so it cannot delay system shutdown.
  hl.exec_cmd("systemctl --user start conky.service")
  hl.exec_cmd("gsr-ui")
  hl.exec_cmd("steam -silent")
  hl.exec_cmd("openrgb --profile disabled")
end)

-- ── Keybinds ─────────────────────────────────────────────────────────────────

-- Lock screen
hl.bind(mainMod .. " + CONTROL + L", hl.dsp.exec_cmd("hyprlock"))

-- Media keys (repeating for hold-to-adjust, locked so they work on lockscreen)
hl.bind("XF86AudioRaiseVolume", hl.dsp.exec_cmd("swayosd-client --output-volume raise"), { repeating = true })
hl.bind("XF86AudioLowerVolume", hl.dsp.exec_cmd("swayosd-client --output-volume lower"), { repeating = true })
hl.bind("XF86AudioMute", hl.dsp.exec_cmd("swayosd-client --output-volume mute-toggle"))
hl.bind("XF86MonBrightnessUp", hl.dsp.exec_cmd("swayosd-client --brightness raise"), { repeating = true })
hl.bind("XF86MonBrightnessDown", hl.dsp.exec_cmd("swayosd-client --brightness lower"), { repeating = true })

-- Apps
hl.bind(mainMod .. " + RETURN", hl.dsp.exec_cmd("kitty"))
hl.bind(mainMod .. " + CONTROL + RETURN", hl.dsp.exec_raw("BROWSER=/usr/bin/chromium chromium --test-type"))
hl.bind(mainMod .. " + SHIFT + R", hl.dsp.exec_cmd("hyprctl reload"))
hl.bind(mainMod .. " + Q", hl.dsp.window.close())
hl.bind(mainMod .. " + SPACE", hl.dsp.window.float())
hl.bind(mainMod .. " + SHIFT + SPACE", hl.dsp.window.pin())
hl.bind(mainMod .. " + F", hl.dsp.window.fullscreen())

-- Screenshots & recording
hl.bind("Print", hl.dsp.exec_cmd("~/.config/hypr/scripts/screenshot.sh"))
hl.bind("SHIFT + Print", hl.dsp.exec_cmd("~/.config/hypr/scripts/screenshot-annotate.sh"))
hl.bind("CTRL + Print", hl.dsp.exec_cmd("~/.config/hypr/scripts/record-toggle.sh"))

-- Launchers
hl.bind(mainMod .. " + D", hl.dsp.exec_cmd("~/.config/hypr/scripts/rofi.sh"))
hl.bind(mainMod .. " + 0", hl.dsp.exec_cmd("~/.config/hypr/scripts/system.sh"))
hl.bind(mainMod .. " + U", hl.dsp.exec_cmd("~/.config/hypr/scripts/util.sh"))

-- Mouse binds: move/resize windows
hl.bind(mainMod .. " + mouse:272", hl.dsp.window.drag(), { mouse = true })
hl.bind(mainMod .. " + mouse:273", hl.dsp.window.resize(), { mouse = true })

-- Focus movement (Vim-style)
hl.bind(mainMod .. " + H", hl.dsp.focus({ direction = "left" }))
hl.bind(mainMod .. " + J", hl.dsp.focus({ direction = "down" }))
hl.bind(mainMod .. " + K", hl.dsp.focus({ direction = "up" }))
hl.bind(mainMod .. " + L", hl.dsp.focus({ direction = "right" }))

-- Move windows
hl.bind(mainMod .. " + SHIFT + J", hl.dsp.window.move({ direction = "down" }))
hl.bind(mainMod .. " + SHIFT + K", hl.dsp.window.move({ direction = "up" }))
-- horizontal move uses swapcol in the scrolling layout
hl.bind(mainMod .. " + SHIFT + H", hl.dsp.layout("swapcol l"))
hl.bind(mainMod .. " + SHIFT + L", hl.dsp.layout("swapcol r"))

-- Move current workspace to adjacent monitor
hl.bind(mainMod .. " + SHIFT + comma", hl.dsp.workspace.move({ monitor = "l" }))
hl.bind(mainMod .. " + SHIFT + period", hl.dsp.workspace.move({ monitor = "r" }))

-- ── Workspace switching ──────────────────────────────────────────────────────

-- Workspaces 1-10
for i = 1, 10 do
  local key = i == 10 and "grave" or tostring(i)
  hl.bind(mainMod .. " + " .. key, hl.dsp.focus({ workspace = i }))
  hl.bind(mainMod .. " + SHIFT + " .. key, hl.dsp.window.move({ workspace = i, follow = false }))
end

-- Workspaces 11-22 (F1-F12)
for i = 1, 12 do
  local ws = 10 + i
  hl.bind(mainMod .. " + F" .. i, hl.dsp.focus({ workspace = ws }))
  hl.bind(mainMod .. " + SHIFT + F" .. i, hl.dsp.window.move({ workspace = ws, follow = false }))
end

-- Passthrough mode
hl.bind(mainMod .. " + R", hl.dsp.submap("passthrough"))
hl.define_submap("passthrough", function()
  hl.bind(mainMod .. " + escape", hl.dsp.submap("reset"))
end)
