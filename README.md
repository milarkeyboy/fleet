# Fleet

Repository containing configurations for the machines and working environments
that I use.

Must be cloned directly in the home directory (for out-of-store symlinks to
work) i.e. `~/fleet`.

## Design

This repository will support building NixOS configurations for multiple
machines, sharing modules where the intended use of those machines overlap.
Where possible, the following rules shall apply:

- The latest stable version of NixOS shall be used. We may change this to use
  the unstable channels in future.
- The Nix language shall be used for configuring tools, environments, etc.
  where said configuration suits the declarative nature of Nix. For tools that
  use more imperative domain languages for configuration (e.g. Lua for nvim),
  we shall aim to use said domain language instead if it is ergonomic to do so.
- Nix flakes are preferred over vanilla Nix, due to the useful nature of those
  experimental features.
- No secrets shall be committed to this repository; secrets and credentials are
  managed externally.
- Binaries may end up being committed if it is useful to do so, but they will
  be put into git LFS and not treated as regular objects.
- Aim to keep each Nix file to either a single tool/application or function (if
  that configuration is fairly complex), or one category of tools/applications
  or functions. Some examples:
    - coding.nix
    - daw.nix
    - desktop-environment.nix
    - gaming.nix

## Layout

```text
flake.nix                  Flake inputs and host outputs.
*.nix                      Per-machine top-level selection of modules.
users/                     Per-user configs, including home manager.
hardware-configurations/   Per-machine hardware configuration, typically autogen.
modules/base.nix           Shared system defaults.
moduels/*.nix              Singular functions or categories of functions.
```

## Targets

All targets currently assume `x86_64-linux`. That should be revisited if any
machine turns out to be ARM or otherwise unusual.

## Build, Test, and Switch

Where `HOST` is the target we're building of, build it without activating it:

```sh
sudo nixos-rebuild build --flake .#$HOST
```

To activate the configuration until the next reboot, use `test`:

```sh
sudo nixos-rebuild test --flake .#$HOST
```

To switch to the configuration and make it the default boot entry:

```sh
sudo nixos-rebuild switch --flake .#$HOST
```

<!-- TODO: Rewrite this, as it was AI generated. -->
## XLN Online Installer under Wine

`modules/daw.nix` provides `wine-xln`. After rebuilding the system, run the
Windows installer with:

```sh
wine-xln "$HOME/Downloads/XLN Online Installer.exe"
```

For subsequent launches:

```sh
wine-xln "$HOME/.wine/drive_c/Program Files/XLN Audio/XLN Online Installer/XLN Online Installer.exe"
```

The launcher uses the same Wine build as yabridge and defaults to `~/.wine`;
`WINEPREFIX` can select another 64-bit prefix. It initialises/updates the prefix
and replaces its three 64-bit `dxgi`, `d3d11`, and `d3d10core` DLLs with DXVK on
each launch. Existing native versions of those DLLs are overwritten. DLL
selection is set through the launch environment, inherited by XLN's child
processes, rather than global registry overrides. DXVK logs go in the prefix.
Close XLN before relaunching through the wrapper.

### Why DXVK is needed

Tested with Wine Staging 11.8 and DXVK 2.7.1: the downloaded installer 4.0.6
updates to 5.0.0, then the new process hangs without showing a window. The
updated executable uses JUCE 8.0.13. Wine's
[`IDXGIOutput::WaitForVBlank`](https://github.com/wine-mirror/wine/blob/wine-11.8/dlls/dxgi/output.c)
returns `E_NOTIMPL`. JUCE's
[`VBlankThread`](https://github.com/juce-framework/JUCE/blob/8.0.13/modules/juce_gui_basics/native/juce_VBlank_windows.cpp)
retries on failure without checking its exit flag, while its destructor waits
for the thread to finish. Debugger stacks matched that loop and wait.

DXVK implements the call. With its DLLs selected, the original installer
successfully updated, restarted, and displayed the login screen. Authentication
and product installation have not yet been verified. Disabling `d3d11` is not a
workaround: the updated executable imports it directly and cannot load without
it. Use the original download rather than manually launching the temporary
`updateBinary` executable, which expects XLN's update context and arguments.

<!-- TODO: Document desktop selection through modules/desktop-environment/kde.nix
and sway.nix: desktop selects Sway; both laptops select KDE. Shared defaults live
under /etc and session services run per user; Home Manager remains unchanged.
Recommend a shortcut reference covering launching, workspaces, window selection,
clipboard selection/clearing, screenshots, locking and the session menu. Explain
personal overrides and the need to retain /etc/sway/config.d/* integration.
Document desktop.nix's single-monitor 3840x2160@60Hz, scale 1.45 settings, output
identification with swaymsg -t get_outputs, fractional-scale XWayland blurring,
and console font sizing for tuigreet.
Explain session-only clipboard history, five-minute locking, ten-minute display
power-off, idle inhibition, and locking before suspend. Note GNOME Keyring's
password-login unlocking and separate migration of existing KDE wallet secrets.
Add a runtime checklist for NVIDIA rendering, login/logout, applications, display
scaling, clipboard isolation, window switching, lock/resume, keyring, removable
media and browser screen sharing (the wlroots portal shares outputs).
Recommend building before activation, retaining a known-working boot generation,
and testing from a TTY after saving work: changing display managers may interrupt
the graphical session. Explain rebooting into the previous generation to recover;
avoid switch/garbage collection until the trial succeeds. Update the Sway TODO
below once the runtime trial has passed.
-->

## TODO

- Generate and review real hardware configurations for:
    - Personal laptop (`laptop`)
    - Work laptop (`work-laptop`)
    - Home server (`server`)
- Fix shutdown on desktop: always reboots
- Transition to sway, configured like Manjaro community edition
- Add apps for work laptop, e.g. Microsoft teams (PWA?), with working screen
  share
- Game streaming from home pc to home server (e.g. sunshine/moonlight)
- Remove dependence on the yabridge flake, build with 32-bit bridge support
  for older plugins.
- Manually refactor the readme for the pi extensions, and get an agent to
  refactor/trim the code to match. Consider using ponytail to do it.
- Allow specifying list of skills to make available to workflow subagents.
- Pi extensions:
    - Constrain agents such that they cannot edit Markdown.
    - Manually edit the READMEs of all extensions, and get an agent to trim off
      the unnecessary functionality.
