{ pkgs, ... }:

{
  imports = [
    ./hardware-configurations/server.nix
    ./modules/base.nix
    ./modules/server.nix
    ./users/mitch.nix
  ];

  networking.hostName = "server";

  users.users.mitch = {
    openssh.authorizedKeys.keys = [
      # Desktop
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGcpPRgQFv93o4h1p8oqZbsrkJCCS4QWmqQsKQIYG5t7 mitch@nixos"
    ];

    # Allow hardware video acceleration.
    extraGroups = [ "render" ];
  };

  # Provide Intel VA-API acceleration.
  hardware.graphics = {
    enable = true;
    extraPackages = [ pkgs.intel-media-driver ];
  };
}
