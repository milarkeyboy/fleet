# Fleet

Repository containing configurations for the machines and working environments
that I use.

## Design

This repository will support building NixOS configurations for multiple
machines, sharing modules where the intended use of those machines overlap.
Where possible, the following rules shall apply:

- The latest stable version of NixOS shall be used. We may change this to use
  the unstable channels in future. The current flake target is `nixos-26.05`.
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
home/                      Home Manager configuration.
hosts/                     Per-machine NixOS entry points.
modules/nixos/base.nix     Shared system defaults.
modules/nixos/desktop/     Desktop environment modules.
modules/nixos/roles/       Reusable machine role modules.
```

## Targets

- `desktop`: home PC, currently KDE Plasma workstation baseline.
- `laptop`: personal laptop, currently KDE Plasma workstation baseline.
- `work-laptop`: work laptop, currently KDE Plasma workstation baseline.
- `server`: home server baseline with SSH enabled and no desktop role.

All targets currently assume `x86_64-linux`. That should be revisited if any
machine turns out to be ARM or otherwise unusual.

## Bootstrapping a Host

This repository was started on a machine that is not currently running NixOS or
Nix, so the first pass is source structure only. Before building any real host,
generate and review that machine's hardware configuration from a NixOS
installer or existing NixOS system. When installing to mounted filesystems under
`/mnt`, include `--root /mnt`; on an already-installed NixOS system, omit it.

```sh
sudo nixos-generate-config --root /mnt --show-hardware-config > hosts/desktop/hardware-configuration.nix
```

Then uncomment the matching `./hardware-configuration.nix` import in the host's
`configuration.nix`.

Review at least the following hardware details before switching:

- Boot mode and bootloader choice: UEFI/systemd-boot vs BIOS/GRUB.
- Disk layout, filesystem types, encrypted volumes, swap, and UUIDs.
- CPU vendor and microcode setting.
- GPU vendor and driver requirements.
- Wi-Fi, Bluetooth, audio, camera, and laptop power-management hardware.
- Server storage topology, network interface names, and static addressing.

User passwords, SSH keys, service credentials, API keys, work VPN details, and
other secrets must not be committed. Set initial passwords during installation
or add an external secrets mechanism later.

## Build, Test, and Switch

Once Nix is available, create the lock file:

```sh
nix flake lock
```

Choose the target configuration by setting `HOST` to one of `desktop`,
`laptop`, `work-laptop`, or `server`:

```sh
HOST=desktop
```

After that host has a real `hardware-configuration.nix`, build it without
activating it:

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

Use `switch` only after the build and hardware review look correct. Run
`nix flake check` once all declared hosts have real hardware imports, because
flake checks may evaluate every `nixosConfigurations` entry.

## TODO

- Generate and review real hardware configurations for:
    - Home PC (`desktop`)
    - Personal laptop (`laptop`)
    - Work laptop (`work-laptop`)
    - Home server (`server`)
- Consider `nixos-hardware` once exact machine models are known.
- Add a VM/check target for validating common modules before touching real
  hardware.
- Add a secrets mechanism such as `sops-nix` or `agenix`.
- Add CI or a binary cache once configurations can be evaluated consistently.
- Add neovim Lua code in a way that keeps it in Lua but is imported by Nix.
- DAW setup with Reaper and yabridge for home PC
- Games using Steam for home pc
- Transition to sway, configured like Manjaro community edition
- Add apps for work laptop, e.g. Microsoft teams (PWA?), with working screen
  share
- Some sort of network file storage for home server
- Game streaming from home pc to home server (e.g. sunshine/moonlight)
