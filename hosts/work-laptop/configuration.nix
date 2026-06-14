{ ... }:

{
  # Host imports compose the shared fleet defaults with this machine's role.
  # Add work-only modules here for employer-specific apps, VPNs, or policies.
  imports = [
    ../../modules/base.nix
    ../../modules/user.nix
    ../../modules/workstation.nix
    # Generate this on the target machine before the first real build:
    # ./hardware-configuration.nix
  ];

  # TODO: confirm work-specific apps, browser/PWA requirements, VPN needs,
  # screen sharing support, and any employer policy constraints before adding
  # packages or services here.
}
