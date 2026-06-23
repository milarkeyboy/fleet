{ ... }:

{
  imports = [
    ./hardware-configurations/desktop.nix
    ./modules/base.nix
    ./modules/workstation.nix
    ./users/mitch.nix
  ];

  networking.hostName = "desktop";

  # TODO: confirm GPU vendor/driver, audio interface/MIDI needs, Steam, Reaper,
  # yabridge, and Sunshine/Moonlight roles for this host.
}
