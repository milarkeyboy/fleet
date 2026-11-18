# Fleet

Repository containing configurations for the machines and working environments
that I use.

Must be cloned directly in the home directory (for out-of-store symlinks to
work) i.e. `~/fleet`. Clone with `--recurse-submodules`, or run
`git submodule update --init --recursive` afterwards, to fetch bundled skills.

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

## Updating Specific Dependencies

Flake inputs can be updated individual, without affecting other locked
dependencies. To update the coding agent, for example:

```bash
nix flake update pi
```

## Wine on DAW machines

Both `wine` and yabridge use Wine Staging with DXVK for Direct3D 10/11.
`modules/daw.nix` passes the yabridge flake’s Wine build to `modules/wine.nix`.
On first use the wrapper links DXVK’s `dxgi`, `d3d11` and `d3d10core` DLLs into the selected
prefix (`WINEPREFIX`, normally `~/.wine`). This replaces existing copies of
those DLLs. Back up any custom versions before using the prefix. DXVK needs
a working Vulkan driver.

To use Wine’s built-in renderer for one program, or for plugins in one REAPER
session, launch it with:

```sh
WINEDLLOVERRIDES='dxgi,d3d11,d3d10core=b' wine program.exe
WINEDLLOVERRIDES='dxgi,d3d11,d3d10core=b' reaper
```

### XLN Online Installer

Run the original download and let it restart itself:

```sh
wine "$HOME/Downloads/XLN Online Installer.exe"
```

After installation, start it with:

```sh
wine 'C:\Program Files\XLN Audio\XLN Online Installer\XLN Online Installer.exe'
```

XLN 4.0.6 updates to 5.0.0, which uses JUCE 8.0.13. Wine Staging 11.8 returns
`E_NOTIMPL` for [`WaitForVBlank`](https://github.com/wine-mirror/wine/blob/wine-11.8/dlls/dxgi/output.c).
[JUCE’s graphics thread](https://github.com/juce-framework/JUCE/blob/8.0.13/modules/juce_gui_basics/native/juce_VBlank_windows.cpp)
keeps retrying that call without checking whether it should exit. The installer
then hangs waiting for the thread, before it can show its window. DXVK 2.7.1
implements the call; the updated installer reaches the login screen.

## TODO

- Generate and review real hardware configurations for:
    - Personal laptop (`laptop`)
    - Work laptop (`work-laptop`)
    - Home server (`server`)
- Fix shutdown on desktop: always reboots
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
- Manage only a subset of the Pi settings that don't need to differ between
  machines e.g. apply an 'overlay' from Nix.
