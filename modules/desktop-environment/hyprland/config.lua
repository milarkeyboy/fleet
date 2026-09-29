local mod = "SUPER"
local term = "uwsm app -- footclient"
local menu = "uwsm app -- rofi -show drun"
local lock = "hyprlock -c /etc/xdg/hypr/hyprlock.conf"

hl.monitor({ output = "", mode = "preferred", position = "auto", scale = 1 })

hl.config({
    xwayland = {
        -- Let X11 windows scale themselves rather than interpolating them.
        force_zero_scaling = true,
    },
    general = {
        gaps_in = 0,
        gaps_out = 0,
        border_size = 4,
        col = {
            active_border = "rgb(356859)",
            inactive_border = "rgb(20242b)",
        },
        layout = "dwindle",
        resize_on_border = true,
    },
    animations = { enabled = false },
    dwindle = {
        -- Split on the right or bottom.
        force_split = 2,
    },
    group = {
        col = {
            border_active = "rgb(356859)",
            border_inactive = "rgb(20242b)",
        },
    },
    misc = {
        disable_hyprland_logo = true,
        disable_splash_rendering = true,
        background_color = "rgb(20242b)",
    },
    input = {
        -- Keep focus from following the pointer automatically.
        follow_mouse = 2,
        float_switch_override_focus = 0,
    },
})

hl.on("hyprland.start", function()
    hl.exec_cmd("hyprctl setcursor Adwaita 24")
end)

hl.bind(mod .. " + RETURN", hl.dsp.exec_cmd(term))
hl.bind(mod .. " + D", hl.dsp.exec_cmd(menu))
hl.bind("ALT + SPACE", hl.dsp.exec_cmd(menu))
hl.bind(mod .. " + SHIFT + Q", hl.dsp.window.close())
hl.bind(mod .. " + SHIFT + C", hl.dsp.exec_cmd("hyprctl reload"))
hl.bind("ALT + TAB", hl.dsp.window.cycle_next())
hl.bind("ALT + TAB", hl.dsp.window.bring_to_top())
hl.bind(mod .. " + TAB", hl.dsp.focus({ workspace = "previous" }))

-- Allocate workspaces on demand and keep silent moves separate from followed moves.
hl.bind(mod .. " + N", hl.dsp.focus({ workspace = "empty" }))
hl.bind(mod .. " + SHIFT + N", hl.dsp.window.move({ workspace = "empty", follow = false }))
hl.bind(mod .. " + SHIFT + M", hl.dsp.window.move({ workspace = "empty", follow = true }))

-- Clipboard.
hl.bind(mod .. " + SHIFT + P", hl.dsp.exec_cmd("fleet-clipboard select"))
hl.bind(mod .. " + CTRL + P", hl.dsp.exec_cmd("fleet-clipboard clear"))
hl.bind("PRINT", hl.dsp.exec_cmd("grimblast copy area"))

-- Keep arrow and vim keys equivalent for window selection and movement.
for key, direction in pairs({ LEFT = "l", DOWN = "d", UP = "u", RIGHT = "r", H = "l", J = "d", K = "u", L = "r" }) do
    hl.bind(mod .. " + " .. key, hl.dsp.focus({ direction = direction }))
    hl.bind(mod .. " + SHIFT + " .. key, hl.dsp.window.move({ direction = direction }))
end

-- Zero selects workspace ten.
for workspace = 1, 10 do
    local key = workspace % 10
    hl.bind(mod .. " + " .. key, hl.dsp.focus({ workspace = workspace }))
    hl.bind(mod .. " + SHIFT + " .. key, hl.dsp.window.move({ workspace = workspace, follow = false }))
end

hl.bind(mod .. " + F", hl.dsp.window.fullscreen())

-- Floating and scratchpad.
hl.bind(mod .. " + SHIFT + SPACE", hl.dsp.window.float({ action = "toggle" }))
hl.bind(mod .. " + SHIFT + MINUS", hl.dsp.window.move({ workspace = "special:scratchpad", follow = false }))
hl.bind(mod .. " + MINUS", hl.dsp.workspace.toggle_special("scratchpad"))

-- Mouse dragging and resizing.
hl.bind(mod .. " + mouse:272", hl.dsp.window.drag(), { mouse = true })
hl.bind(mod .. " + mouse:273", hl.dsp.window.resize(), { mouse = true })

-- Resize repeatedly until the mode is dismissed.
hl.bind(mod .. " + R", hl.dsp.submap("resize"))
hl.define_submap("resize", function()
    for key, delta in pairs({
        LEFT = { -10, 0 }, DOWN = { 0, 10 }, UP = { 0, -10 }, RIGHT = { 10, 0 },
        H = { -10, 0 }, J = { 0, 10 }, K = { 0, -10 }, L = { 10, 0 },
    }) do
        hl.bind(key, hl.dsp.window.resize({ x = delta[1], y = delta[2], relative = true }), { repeating = true })
    end
    hl.bind("RETURN", hl.dsp.submap("reset"))
    hl.bind("ESCAPE", hl.dsp.submap("reset"))
end)

-- Session actions retain the original per-key reset behaviour.
hl.bind(mod .. " + SHIFT + E", hl.dsp.submap("session"))
hl.define_submap("session", function()
    hl.bind("L", hl.dsp.exec_cmd(lock))
    hl.bind("L", hl.dsp.submap("reset"))
    hl.bind("E", hl.dsp.exec_cmd("uwsm stop"))
    hl.bind("S", hl.dsp.exec_cmd("systemctl suspend"))
    hl.bind("S", hl.dsp.submap("reset"))
    hl.bind("R", hl.dsp.exec_cmd("systemctl reboot"))
    hl.bind("P", hl.dsp.exec_cmd("systemctl poweroff"))
    hl.bind("RETURN", hl.dsp.submap("reset"))
    hl.bind("ESCAPE", hl.dsp.submap("reset"))
end)

-- Media keys continue working while locked; volume and brightness also repeat.
local media = { locked = true }
local repeating_media = { locked = true, repeating = true }
hl.bind("XF86AudioRaiseVolume", hl.dsp.exec_cmd("wpctl set-volume -l 1 @DEFAULT_AUDIO_SINK@ 5%+"), repeating_media)
hl.bind("XF86AudioLowerVolume", hl.dsp.exec_cmd("wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-"), repeating_media)
hl.bind("XF86AudioMute", hl.dsp.exec_cmd("wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle"), media)
hl.bind("XF86AudioMicMute", hl.dsp.exec_cmd("wpctl set-mute @DEFAULT_AUDIO_SOURCE@ toggle"), media)
hl.bind("XF86AudioPlay", hl.dsp.exec_cmd("playerctl play-pause"), media)
hl.bind("XF86AudioNext", hl.dsp.exec_cmd("playerctl next"), media)
hl.bind("XF86AudioPrev", hl.dsp.exec_cmd("playerctl previous"), media)
hl.bind("XF86MonBrightnessUp", hl.dsp.exec_cmd("brightnessctl set +5%"), repeating_media)
hl.bind("XF86MonBrightnessDown", hl.dsp.exec_cmd("brightnessctl set 5%-"), repeating_media)

-- Load host-specific output rules after the shared defaults.
dofile("/etc/xdg/hypr/conf.d/outputs.lua")
