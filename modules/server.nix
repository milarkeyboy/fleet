{ ... }:

{
  # Servers should be reachable over SSH.
  services.openssh = {
    enable = true;
    openFirewall = true;

    # Require key authorisation.
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "no";
    };
  };

}
