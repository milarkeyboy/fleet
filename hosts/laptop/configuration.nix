{ ... }:

{
  imports = [
    ../../modules/nixos/base.nix
    ../../modules/nixos/users.nix
    ../../modules/nixos/roles/workstation.nix
    # Generate this on the target machine before the first real build:
    # ./hardware-configuration.nix
  ];

  # TODO: confirm laptop model, CPU vendor, GPU stack, Wi-Fi/Bluetooth chipset,
  # power management, suspend behavior, and display scaling requirements.
}
