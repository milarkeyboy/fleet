{ pkgs, ... }:

{
  # Servers should be reachable over SSH.
  services.openssh = {
    enable = true;
    openFirewall = true;
  };

}
