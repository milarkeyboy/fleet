{ ... }:

{
  imports = [
    ../../modules/nixos/base.nix
    ../../modules/nixos/users.nix
    ../../modules/nixos/roles/server.nix
    # Generate this on the target machine before the first real build:
    # ./hardware-configuration.nix
  ];

  # TODO: confirm storage layout, backup strategy, file sharing protocol,
  # network interface naming, static addressing needs, and game streaming role.
}
