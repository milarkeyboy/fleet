{ ... }:

{
  imports = [
    ../../modules/nixos/base.nix
    ../../modules/nixos/users.nix
    ../../modules/nixos/roles/workstation.nix
    # Generate this on the target machine before the first real build:
    # ./hardware-configuration.nix
  ];

  # TODO: confirm work-specific apps, browser/PWA requirements, VPN needs,
  # screen sharing support, and any employer policy constraints before adding
  # packages or services here.
}
