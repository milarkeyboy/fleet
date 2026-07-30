{ ... }:

{
  imports = [
    ./hardware-configurations/desktop.nix
    ./modules/base.nix
    ./modules/daw.nix
    ./modules/workstation.nix
    ./modules/coding.nix
    ./users/mitch.nix
  ];

  networking.hostName = "desktop";

  # TODO: confirm GPU vendor/driver.
}
