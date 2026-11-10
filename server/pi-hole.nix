# Before the first activation, run these commands on the server to generate a
# dashboard password in a root-only environment file. The service cannot start
# without /var/lib/pihole.env. Keep this file outside Git and the Nix store.
#
# sudo sh -c '
#   umask 077
#   password=$(head -c 24 /dev/urandom | base64)
#   printf "FTLCONF_webserver_api_password=%s\n" "$password" \
#     > /var/lib/pihole.env
# '
#
# Display the generated password and save it in a password manager:
#
# sudo cut -d= -f2- /var/lib/pihole.env
#
# Then activate the NixOS configuration. Rerunning the command replaces the
# password; restart an existing service with sudo systemctl restart pihole-ftl.
{ config, ... }:

{
  # Filter LAN DNS while leaving DHCP on the router.
  services.pihole-ftl = {
    enable = true;

    # Allow clients to query DNS over UDP and TCP port 53. TCP is needed
    # for responses that exceed UDP limits and for clients that request it.
    openFirewallDNS = true;

    # Allow access to the dashboard on its configured HTTP and HTTPS ports.
    # These rules apply to all interfaces; keep these ports off the WAN.
    openFirewallWebserver = true;

    settings.dns = {
      # Accept DNS queries only from clients on subnets attached to this
      # server. Routed clients on other subnets cannot use this resolver.
      listeningMode = "LOCAL";

      # Quad9's preferred (9.9.9.9) and alternate (149.112.112.112) IPv4
      # resolvers also block known malicious domains for unblocked queries.
      upstreams = [
        "9.9.9.9"
        "149.112.112.112"
      ];
    };

    # Steven Black's unified list combines ad and tracking domains with
    # malware domains, providing a general-purpose baseline for DNS blocking.
    lists = [
      {
        url = "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts";
        description = "Steven Black's unified adlist";
      }
    ];
  };

  services.pihole-web = {
    enable = true;

    # Redirect HTTP on port 80 to HTTPS on port 443 so dashboard passwords
    # and sessions use TLS. The r suffix redirects; s enables TLS with
    # Pi-hole's generated self-signed certificate.
    ports = [
      "80r"
      "443s"
    ];
  };

  # Keep the dashboard password outside Git and the Nix store. This root-only
  # file must define FTLCONF_webserver_api_password before the service starts.
  systemd.services.pihole-ftl.serviceConfig.EnvironmentFile = "/var/lib/pihole.env";

  # Refresh downloaded blocklists even when the server stays up for weeks.
  systemd.services.pihole-gravity = {
    description = "Update Pi-hole blocklists";
    wants = [ "network-online.target" ];
    requires = [ "pihole-ftl.service" ];
    after = [
      "network-online.target"
      "pihole-ftl.service"
    ];
    serviceConfig = {
      Type = "oneshot";
      User = "pihole";
      Group = "pihole";
      ExecStart = "${config.services.pihole-ftl.piholePackage}/bin/pihole updateGravity";
    };
  };
  systemd.timers.pihole-gravity = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "weekly";
      Persistent = true;
      RandomizedDelaySec = "1h";
    };
  };
}
