{ ... }:

{
  # Host imports compose the shared fleet defaults with this machine's role.
  # Add desktop-only modules here when a feature should not apply to laptops.
  imports = [
    ../../modules/base.nix
    ../../modules/user.nix
    ../../modules/workstation.nix
    # Generate this on the target machine before the first real build:
    # ./hardware-configuration.nix
  ];

  # TODO: confirm GPU vendor/driver, audio interface/MIDI needs, Steam, Reaper,
  # yabridge, and Sunshine/Moonlight roles for this host.
}
