{ config, pkgs, ... }:

{
  imports = [ ../modules/brave.nix ];

  # Give remote desktop clients access to the TV account, not the admin account.
  users.users.tv = {
    isNormalUser = true;
    hashedPassword = "!";
    extraGroups = [
      "video"
      "render"
    ];
  };

  programs.labwc.enable = true;
  xdg.portal.enable = true;

  # Start a fresh desktop at boot and whenever the compositor exits.
  services.greetd = {
    enable = true;
    restart = true;
    settings = rec {
      initial_session = {
        user = "tv";
        command = "${config.programs.labwc.package}/bin/labwc";
      };
      default_session = initial_session;
    };
  };

  # Trust VNC clients on the wired LAN; leave other source networks blocked.
  networking.firewall.extraCommands = ''
    iptables -A nixos-fw -i enp2s0 -s 192.168.1.0/24 \
      -p tcp --dport 5900 -j nixos-fw-accept
  '';

  # PipeWire supplies HDMI audio; pavucontrol can select the TV output.
  security.rtkit.enable = true;
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    pulse.enable = true;
  };

  home-manager.users.tv = {
    home.username = "tv";
    home.homeDirectory = "/home/tv";
    home.stateVersion = "26.05";
    home.packages = [ pkgs.pavucontrol ];

    wayland.windowManager.labwc = {
      enable = true;
      package = null;
      environment = [
        "XDG_CURRENT_DESKTOP=labwc:wlroots"
        "XDG_SESSION_TYPE=wayland"
        "NIXOS_OZONE_WL=1"
      ];

      # Keep applications manual: right-click the desktop to launch them.
      menu = [
        {
          menuId = "root-menu";
          label = "TV";
          items = [
            {
              label = "Brave";
              action = {
                name = "Execute";
                command = "${pkgs.brave}/bin/brave";
              };
            }
            {
              label = "Audio";
              action = {
                name = "Execute";
                command = "${pkgs.pavucontrol}/bin/pavucontrol";
              };
            }
          ];
        }
      ];
    };

    services.wayvnc = {
      enable = true;
      autoStart = true;
      systemdTarget = "labwc-session.target";
      settings = {
        address = "0.0.0.0";
        port = 5900;
        enable_auth = false;
      };
    };

    # Recover remote access if WayVNC fails during the desktop session.
    systemd.user.services.wayvnc.Service = {
      Restart = "on-failure";
      RestartSec = 5;
    };
  };
}
