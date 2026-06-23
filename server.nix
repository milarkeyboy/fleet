{ ... }:

{
  imports = [
    ./hardware-configurations/server.nix
    ./modules/base.nix
    ./modules/server.nix
    ./users/mitch.nix
  ];

  networking.hostName = "server";

  # TODO: confirm storage layout, backup strategy, file sharing protocol,
  # network interface naming, static addressing needs, and game streaming role.
}
