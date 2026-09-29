{
  config,
  lib,
  pkgs,
  ...
}:

let
  # Restrict the greeter to Hyprland's packaged UWSM session. Hyprland also
  # provides a direct session, but that bypasses UWSM's systemd lifecycle.
  greetdSessions = pkgs.runCommand "greetd-hyprland-sessions" { } ''
    mkdir -p $out/wayland-sessions $out/xsessions
    ln -s ${config.programs.hyprland.package}/share/wayland-sessions/hyprland-uwsm.desktop \
      $out/wayland-sessions/hyprland-uwsm.desktop
  '';

  # UWSM owns the standard graphical session target, so these processes are
  # stopped with the compositor regardless of its generated instance name.
  sessionService = description: serviceConfig: {
    inherit description;
    wantedBy = [ "graphical-session.target" ];
    after = [ "graphical-session.target" ];
    partOf = [ "graphical-session.target" ];
    serviceConfig = {
      Restart = "on-failure";
    }
    // serviceConfig;
  };

  clipboard = pkgs.writeShellApplication {
    name = "fleet-clipboard";
    runtimeInputs = with pkgs; [
      cliphist
      coreutils
      rofi
      wl-clipboard
    ];
    text = builtins.readFile ./hyprland/clipboard.sh;
  };
in
{
  programs.hyprland = {
    enable = true;
    withUWSM = true;
    xwayland.enable = true;
  };
  # Use the packaged units and their standard graphical-session integration.
  programs.hyprlock.enable = true;
  programs.waybar.enable = true;

  services.greetd = {
    enable = true;
    useTextGreeter = true;
    settings.default_session.command = "${lib.getExe pkgs.tuigreet} --time --sessions ${greetdSessions}/wayland-sessions --xsessions ${greetdSessions}/xsessions --cmd '${lib.getExe pkgs.uwsm} start -e -D Hyprland hyprland.desktop'";
  };
  security.pam.services.greetd.allowNullPassword = lib.mkForce false;

  # These services replace the authentication and file-management integration
  # normally supplied by a full desktop environment.
  services.gnome.gnome-keyring.enable = true;
  # Workstations already run OpenSSH's agent; the keyring supplies secrets only.
  services.gnome.gcr-ssh-agent.enable = false;
  services.gvfs.enable = true;
  services.udisks2.enable = true;
  xdg.portal.enable = true;
  xdg.portal.config.hyprland = {
    default = [
      "hyprland"
      "gtk"
    ];
    "org.freedesktop.impl.portal.Secret" = [ "gnome-keyring" ];
  };

  environment.sessionVariables = {
    NIXOS_OZONE_WL = "1";
    QT_QPA_PLATFORM = "wayland;xcb";
    XCURSOR_THEME = "Adwaita";
    XCURSOR_SIZE = "24";
  };

  programs.foot = {
    enable = true;
    settings.main = {
      font = "JetBrainsMono Nerd Font Mono:size=11";
      dpi-aware = "no";
    };

    # Enable the server for executing footclient, which will boot faster.
    xdg.serverAutostart = true;
  };

  environment.systemPackages = with pkgs; [
    adwaita-icon-theme
    brightnessctl
    grimblast
    lxqt.pcmanfm-qt
    playerctl
    rofi
    wireplumber
    wl-clipboard
    xdg-utils
    libsForQt5.qtwayland
    qt6.qtwayland
    clipboard
  ];

  environment.etc = {
    "xdg/hypr/hyprland.lua".source = ./hyprland/config.lua;
    "xdg/hypr/conf.d/outputs.lua".text = lib.mkDefault "";
    "xdg/gtk-3.0/settings.ini".text = ''
      [Settings]
      gtk-cursor-theme-name=Adwaita
      gtk-cursor-theme-size=24
    '';
    "xdg/gtk-4.0/settings.ini".text = ''
      [Settings]
      gtk-cursor-theme-name=Adwaita
      gtk-cursor-theme-size=24
    '';
    "xdg/rofi/config.rasi".text = ''
      configuration {
        modi: "drun,run";
        font: "JetBrainsMono Nerd Font Mono 11";
        show-icons: true;
        terminal: "foot";
        drun-display-format: "{name}";
      }
    '';
    "xdg/pcmanfm-qt/default/settings.conf".text = ''
      [System]
      Terminal=foot
      FallbackIconThemeName=Adwaita
    '';
    "xdg/mimeapps.list".text = ''
      [Default Applications]
      inode/directory=pcmanfm-qt.desktop;
    '';
    "xdg/mako/config".text = ''
      font=JetBrainsMono Nerd Font Mono 11
      background-color=#20242b
      text-color=#eeeeee
      border-color=#356859
      default-timeout=5000
      [urgency=critical]
      default-timeout=0
    '';
    "xdg/hypr/hyprlock.conf".text = ''
      general {
          hide_cursor = true
      }

      background {
          color = rgb(20242b)
      }

      input-field {
          size = 300, 50
          outline_thickness = 2
          outer_color = rgb(356859)
          inner_color = rgb(20242b)
          font_color = rgb(eeeeee)
          fade_on_empty = false
          placeholder_text = <i>Password...</i>
          fail_text = <i>$FAIL</i>
      }
    '';
    "xdg/hypr/hypridle.conf".text = ''
      general {
          lock_cmd = ${pkgs.procps}/bin/pidof hyprlock || ${pkgs.hyprlock}/bin/hyprlock -c /etc/xdg/hypr/hyprlock.conf
          before_sleep_cmd = ${pkgs.systemd}/bin/loginctl lock-session
          after_sleep_cmd = ${config.programs.hyprland.package}/bin/hyprctl dispatch dpms on
      }

      listener {
          timeout = 300
          on-timeout = ${pkgs.systemd}/bin/loginctl lock-session
      }

      listener {
          timeout = 600
          on-timeout = ${config.programs.hyprland.package}/bin/hyprctl dispatch dpms off
          on-resume = ${config.programs.hyprland.package}/bin/hyprctl dispatch dpms on
      }
    '';
    "xdg/waybar/style.css".source = ./hyprland/waybar.css;
    "xdg/waybar/config".text = builtins.toJSON {
      layer = "top";
      position = "top";
      modules-left = [ "hyprland/workspaces" ];
      modules-center = [ "hyprland/submap" ];
      modules-right = [
        "pulseaudio"
        "network"
        "bluetooth"
        "battery"
        "backlight"
        "idle_inhibitor"
        "tray"
        "clock"
      ];
      "hyprland/submap" = {
        format = "{}";
        max-length = 60;
      };
      clock = {
        format = "{:%a %d %b %H:%M}";
        tooltip-format = "<tt>{calendar}</tt>";
      };
      pulseaudio = {
        format = "Vol {volume}%";
        format-muted = "Muted";
        on-click = "${pkgs.foot}/bin/foot ${pkgs.pulsemixer}/bin/pulsemixer";
        on-click-right = "${pkgs.wireplumber}/bin/wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle";
        on-scroll-up = "${pkgs.wireplumber}/bin/wpctl set-volume -l 1 @DEFAULT_AUDIO_SINK@ 5%+";
        on-scroll-down = "${pkgs.wireplumber}/bin/wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-";
      };
      network = {
        format-wifi = "{essid}";
        format-ethernet = "Ethernet";
        format-disconnected = "Offline";
        tooltip-format = "{ifname}: {ipaddr}";
        on-click = "${pkgs.foot}/bin/foot ${pkgs.networkmanager}/bin/nmtui";
      };
      bluetooth = {
        format = "BT {status}";
        format-connected = "BT {num_connections}";
        on-click = "${pkgs.blueman}/bin/blueman-manager";
      };
      battery = {
        format = "Bat {capacity}%";
        format-charging = "Bat {capacity}% +";
        states = {
          warning = 30;
          critical = 15;
        };
      };
      backlight = {
        format = "Light {percent}%";
        on-scroll-up = "${pkgs.brightnessctl}/bin/brightnessctl set +5%";
        on-scroll-down = "${pkgs.brightnessctl}/bin/brightnessctl set 5%-";
      };
      idle_inhibitor = {
        format = "{icon}";
        format-icons = {
          activated = "Awake";
          deactivated = "Idle";
        };
      };
      tray.spacing = 8;
    };
  };

  # Mako ships its own graphical-session-aware unit but has no NixOS module.
  systemd.packages = [ pkgs.mako ];
  systemd.user.services = {
    mako.wantedBy = [ "graphical-session.target" ];
    polkit-agent = sessionService "Hyprland authentication agent" {
      ExecStart = "${pkgs.polkit_gnome}/libexec/polkit-gnome-authentication-agent-1";
    };
    # PCManFM-Qt starts its daemon on first use, which delays the first window.
    pcmanfm-daemon = sessionService "PCManFM-Qt file manager daemon" {
      ExecStart = "${pkgs.lxqt.pcmanfm-qt}/bin/pcmanfm-qt --daemon-mode";
    };
    cliphist = sessionService "Session-only clipboard history" {
      ExecStart = "${lib.getExe clipboard} watch";
      RuntimeDirectory = "fleet-clipboard";
      RuntimeDirectoryMode = "0700";
      UMask = "0077";
    };
  };
}
