{ ... }:

{
  imports = [
    ./hardware-configurations/laptop.nix
    ./modules/base.nix
    ./modules/workstation.nix
    ./users/mitch.nix
  ];

  networking.hostName = "laptop";

  # TODO: confirm laptop model, CPU vendor, GPU stack, Wi-Fi/Bluetooth chipset,
  # power management, suspend behavior, and display scaling requirements.
}
