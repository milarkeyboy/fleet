{
  config,
  lib,
  pkgs,
  ...
}:

let
  # Shared unit definitions still run as the logged-in user. Binding every
  # desktop process to the compositor prevents leftovers across logins.
  sessionService = description: serviceConfig: {
    inherit description;
    wantedBy = [ "sway-session.target" ];
    after = [ "sway-session.target" ];
    partOf = [ "sway-session.target" ];
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
    text = builtins.readFile ./sway/clipboard.sh;
  };

  screenshot = pkgs.writeShellApplication {
    name = "fleet-screenshot";
    runtimeInputs = with pkgs; [
      grim
      slurp
      wl-clipboard
    ];
    text = ''
      # Cancelling region selection leaves the clipboard untouched.
      region=$(slurp) || exit 0
      grim -g "$region" - | wl-copy --type image/png
    '';
  };

  session = pkgs.writeShellApplication {
    name = "fleet-sway-session";
    runtimeInputs = [ pkgs.systemd ];
    text = ''
      # Also clean up if the compositor fails, when its IPC shutdown subscriber
      # may be unable to stop the user targets and remove clipboard history.
      cleanup() {
        systemctl --user stop sway-session.target graphical-session.target
        systemctl --user unset-environment DISPLAY WAYLAND_DISPLAY SWAYSOCK XDG_CURRENT_DESKTOP
      }
      trap cleanup EXIT
      ${lib.getExe config.programs.sway.package} "$@"
    '';
  };
in
{
  assertions = [
    {
      assertion =
        !config.services.displayManager.sddm.enable && !config.services.desktopManager.plasma6.enable;
      message = "Select one desktop-environment module per host: KDE or Sway.";
    }
  ];

  programs.sway = {
    enable = true;
    wrapperFeatures.gtk = true;
    extraSessionCommands = ''
      export XDG_SESSION_TYPE=wayland
    '';
    extraPackages = with pkgs; [
      brightnessctl
      foot
      lxqt.pcmanfm-qt
      playerctl
      rofi
      swayidle
      swaylock
      swayr
      waybar
      wireplumber
      wl-clipboard
      xdg-utils
      adwaita-icon-theme
      libsForQt5.qtwayland
      qt6.qtwayland
      clipboard
      screenshot
    ];
  };

  services.greetd = {
    enable = true;
    useTextGreeter = true;
    settings.default_session.command = "${lib.getExe pkgs.tuigreet} --time --cmd ${lib.getExe session}";
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
  xdg.portal.config.sway."org.freedesktop.impl.portal.Secret" = [ "gnome-keyring" ];

  # Explicit session units own the applets, avoiding duplicate XDG autostarts.
  services.xserver.desktopManager.runXdgAutostartIfNone = false;

  environment.sessionVariables = {
    NIXOS_OZONE_WL = "1";
    QT_QPA_PLATFORM = "wayland;xcb";
  };

  environment.etc = {
    "sway/config".source = ./sway/config;
    "xdg/foot/foot.ini".text = ''
      [main]
      font=JetBrainsMono Nerd Font Mono:size=11
      dpi-aware=no
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
    "xdg/swaylock/config".text = ''
      color=20242b
      show-failed-attempts
    '';
    "xdg/swayidle/config".text = ''
      timeout 300 '${pkgs.swaylock}/bin/swaylock -f -C /etc/xdg/swaylock/config'
      timeout 600 '${config.programs.sway.package}/bin/swaymsg "output * power off"' resume '${config.programs.sway.package}/bin/swaymsg "output * power on"'
      before-sleep '${pkgs.swaylock}/bin/swaylock -f -C /etc/xdg/swaylock/config'
      after-resume '${config.programs.sway.package}/bin/swaymsg "output * power on"'
      lock '${pkgs.swaylock}/bin/swaylock -f -C /etc/xdg/swaylock/config'
    '';
    "xdg/swayr/config.toml".source = (pkgs.formats.toml { }).generate "swayr-config.toml" {
      menu = {
        executable = "${pkgs.rofi}/bin/rofi";
        args = [
          "-dmenu"
          "-i"
          "-p"
          "{prompt}"
        ];
      };
      format = {
        window_format = "{app_name} — {title} on workspace {workspace_name}";
        html_escape = false;
      };
    };
    "xdg/waybar/style.css".source = ./sway/waybar.css;
    "xdg/waybar/config".text = builtins.toJSON {
      layer = "top";
      position = "top";
      modules-left = [
        "sway/workspaces"
        "sway/mode"
      ];
      modules-center = [ "sway/window" ];
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
      "sway/window".max-length = 60;
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

  systemd.user.services = {
    waybar = sessionService "Sway status bar" {
      ExecStart = "${pkgs.waybar}/bin/waybar";
    };
    mako = sessionService "Sway notifications" {
      ExecStart = "${pkgs.mako}/bin/mako --config /etc/xdg/mako/config";
    };
    swayrd = sessionService "Sway window selection" {
      ExecStart = "${pkgs.swayr}/bin/swayrd";
    };
    swayidle = sessionService "Sway locking and display power management" {
      ExecStart = "${pkgs.swayidle}/bin/swayidle -w -C /etc/xdg/swayidle/config";
    };
    polkit-agent = sessionService "Sway authentication agent" {
      ExecStart = "${pkgs.polkit_gnome}/libexec/polkit-gnome-authentication-agent-1";
    };
    # Extend the D-Bus unit supplied by services.blueman, retaining its ExecStart.
    blueman-applet = sessionService "Sway Bluetooth agent" { };
    cliphist = sessionService "Session-only clipboard history" {
      ExecStart = "${lib.getExe clipboard} watch";
      RuntimeDirectory = "fleet-clipboard";
      RuntimeDirectoryMode = "0700";
      UMask = "0077";
    };
  };
}
