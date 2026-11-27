-- Nano: migrated from its Hyprland .conf, preserving its session setup.

---@module 'hl'

local mainMod = "ALT"
local configHome = os.getenv("XDG_CONFIG_HOME") or (os.getenv("HOME") .. "/.config")

hl.config({
  input = {
    kb_options = "ctrl:nocaps",
    touchpad = { natural_scroll = true },
  },
  general = { layout = "scrolling" },
  scrolling = { column_width = 0.5, direction = "right" },
  xwayland = { force_zero_scaling = true, use_nearest_neighbor = true },
  animations = { enabled = true },
})

-- Keep Nano's previous preferred mode, automatic placement, and 125% scale.
hl.monitor({ output = "", mode = "preferred", position = "auto", scale = 1.25 })
hl.env("HYPRCURSOR_THEME", "rose-pine-hyprcursor")
hl.env("HYPRCURSOR_SIZE", "30")

hl.curve("snappy", { type = "bezier", points = { { 0.15, 0.75 }, { 0, 1 } } })
hl.animation({ leaf = "windows",    enabled = true, speed = 3, bezier = "snappy", style = "popin" })
hl.animation({ leaf = "windowsOut", enabled = true, speed = 3, bezier = "snappy", style = "popin" })
hl.animation({ leaf = "windowsMove", enabled = true, speed = 3, bezier = "snappy", style = "slide" })
hl.animation({ leaf = "workspaces", enabled = true, speed = 2, bezier = "snappy", style = "slide" })
for _, leaf in ipairs({ "border", "fade", "layers" }) do
  hl.animation({ leaf = leaf, enabled = true, speed = 3, bezier = "snappy" })
end
hl.gesture({ fingers = 3, direction = "horizontal", action = "scroll_move" })

hl.on("hyprland.start", function()
  hl.exec_cmd("/usr/lib/hyprpolkitagent/hyprpolkitagent")
  hl.exec_cmd("waybar")
  hl.exec_cmd("hyprpaper")
  hl.exec_cmd("nm-applet")
  hl.exec_cmd("fcitx5")
  hl.exec_cmd("hypridle")
  hl.exec_cmd("swayosd-server")
  hl.exec_cmd("systemctl --user import-environment WAYLAND_DISPLAY HYPRLAND_INSTANCE_SIGNATURE"
    .. " && systemctl --user restart nano-sysmon.service")
end)

-- Reattach the layer surface on dock/undock, after outputs have settled.
for _, event in ipairs({ "monitor.added", "monitor.removed" }) do
  hl.on(event, function()
    hl.exec_cmd("sleep 1; systemctl --user try-restart nano-sysmon.service")
  end)
end

local function bind(key, dispatcher, opts)
  hl.bind(mainMod .. " + " .. key, dispatcher, opts)
end

bind("CTRL + L", hl.dsp.exec_cmd("hyprlock"))
bind("RETURN", hl.dsp.exec_cmd("kitty"))
bind("CTRL + RETURN", hl.dsp.exec_raw("env BROWSER=/usr/bin/chromium /usr/bin/chromium"))
bind("SHIFT + R", hl.dsp.reload_config())
bind("Q", hl.dsp.window.close())
bind("SPACE", hl.dsp.window.float({ action = "toggle" }))
bind("SHIFT + SPACE", hl.dsp.window.pin())

local function script(name)
  return hl.dsp.exec_cmd('"' .. configHome .. '/hypr/scripts/' .. name .. '"')
end

hl.bind("Print", script("screenshot.sh"))
hl.bind("SHIFT + Print", script("screenshot-annotate.sh"))
hl.bind("CTRL + Print", script("record-toggle.sh"))
bind("D", script("rofi.sh"))
bind("0", script("system.sh"))
bind("U", script("util.sh"))

local repeatKey = { repeating = true }
hl.bind("XF86AudioRaiseVolume", hl.dsp.exec_cmd("swayosd-client --output-volume raise"), repeatKey)
hl.bind("XF86AudioLowerVolume", hl.dsp.exec_cmd("swayosd-client --output-volume lower"), repeatKey)
hl.bind("XF86AudioMute", hl.dsp.exec_cmd("swayosd-client --output-volume mute-toggle"))
hl.bind("XF86MonBrightnessUp", hl.dsp.exec_cmd("swayosd-client --brightness raise"), repeatKey)
hl.bind("XF86MonBrightnessDown", hl.dsp.exec_cmd("swayosd-client --brightness lower"), repeatKey)

bind("mouse:272", hl.dsp.window.drag(), { mouse = true })
bind("mouse:273", hl.dsp.window.resize(), { mouse = true })

for _, pair in ipairs({ { "H", "left" }, { "J", "down" }, { "K", "up" }, { "L", "right" } }) do
  bind(pair[1], hl.dsp.focus({ direction = pair[2] }))
end
bind("SHIFT + J", hl.dsp.window.move({ direction = "down" }))
bind("SHIFT + K", hl.dsp.window.move({ direction = "up" }))
bind("SHIFT + H", hl.dsp.layout("swapcol l"))
bind("SHIFT + L", hl.dsp.layout("swapcol r"))
bind("SHIFT + comma", hl.dsp.workspace.move({ monitor = "l" }))
bind("SHIFT + period", hl.dsp.workspace.move({ monitor = "r" }))

-- ALT+1…9, grave, and F1…F12 select workspaces 1–22.
for workspace = 1, 22 do
  local key = workspace < 10 and tostring(workspace)
      or workspace == 10 and "grave" or "F" .. (workspace - 10)
  bind(key, hl.dsp.focus({ workspace = workspace }))
  bind("SHIFT + " .. key, hl.dsp.window.move({ workspace = workspace, follow = false }))
end

bind("R", hl.dsp.submap("passthrough"))
hl.define_submap("passthrough", function()
  bind("Escape", hl.dsp.submap("reset"))
end)
