{ ... }:

{
  # Host imports compose the shared fleet defaults with this machine's role.
  # Add laptop-only modules here when hardware details are known.
  imports = [
    ../../modules/base.nix
    ../../modules/user.nix
    ../../modules/workstation.nix
    # Generate this on the target machine before the first real build:
    # ./hardware-configuration.nix
  ];

  # TODO: confirm laptop model, CPU vendor, GPU stack, Wi-Fi/Bluetooth chipset,
  # power management, suspend behavior, and display scaling requirements.
}
