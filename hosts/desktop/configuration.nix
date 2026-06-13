{ ... }:

{
  imports = [
    ../../modules/nixos/base.nix
    ../../modules/nixos/users.nix
    ../../modules/nixos/roles/workstation.nix
    # Generate this on the target machine before the first real build:
    # ./hardware-configuration.nix
  ];

  # TODO: confirm GPU vendor/driver, audio interface/MIDI needs, Steam, Reaper,
  # yabridge, and Sunshine/Moonlight roles for this host.
}
