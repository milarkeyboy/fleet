{ pkgs, ... }:

{
  # Servers should be reachable over SSH. Add hardening or key-only policy here
  # when that policy should apply to every server.
  services.openssh = {
    enable = true;
    openFirewall = true;
  };

  # Server packages should be operational tools needed without a desktop
  # session. Add storage, backup, and monitoring tools here as roles mature.
  environment.systemPackages = with pkgs; [
    btop
  ];
}
