{ ... }:

{
  # Host imports compose the shared fleet defaults with the server role. Add
  # storage or service modules here once the server's responsibilities are set.
  imports = [
    ../../modules/base.nix
    ../../modules/user.nix
    ../../modules/server.nix
    # Generate this on the target machine before the first real build:
    # ./hardware-configuration.nix
  ];

  # TODO: confirm storage layout, backup strategy, file sharing protocol,
  # network interface naming, static addressing needs, and game streaming role.
}
