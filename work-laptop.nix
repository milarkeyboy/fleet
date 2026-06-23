{ ... }:

{
  imports = [
    ./hardware-configurations/work-laptop.nix
    ./modules/base.nix
    ./modules/workstation.nix
    ./users/mitch.nix
  ];

  networking.hostName = "work-laptop";

  # TODO: confirm work-specific apps, browser/PWA requirements, VPN needs,
  # screen sharing support, and any employer policy constraints before adding
  # packages or services here.
}
