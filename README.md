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

## TODO

- Generate and review real hardware configurations for:
    - Personal laptop (`laptop`)
    - Work laptop (`work-laptop`)
    - Home server (`server`)
- Fix garbage collecting old generations
- Fix shutdown on desktop: always reboots
- Transition to sway, configured like Manjaro community edition
- Add apps for work laptop, e.g. Microsoft teams (PWA?), with working screen
  share
- Game streaming from home pc to home server (e.g. sunshine/moonlight)
- Remove dependence on the yabridge flake, build with 32-bit bridge suport
  for older plugins.
