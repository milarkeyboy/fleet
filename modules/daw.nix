{
  pkgs,
  inputs,
  ...
}:

# Module for running a DAW:
# - Reaper is the DAW of choice, and a user service configures it at session startup.
# - Musnix is used for configuring the kernel for low-latency audio production.
#   Most of the contents of that flake could be pasted inline here to avoid
#   external dependency, but it works for now so we can leave it. The RT kernel
#   may also be overkill, possibly check out undoing that later.
# - yabridge is used to run Windows plugins under wine. Have to use
#   `yabridge add ...` and `yabridgectl sync` to add new plugin dirs and
#   syncing new DLLs respectively.
#
# "Why not set powerManagement.cpuFreqGovernor to performance?" - Because
# it doesn't work. The powersave governor appears to work fine with an RT
# setup anywho.

let
  system = pkgs.stdenv.hostPlatform.system;
  yabridgePkgs = inputs.yabridge-flake.packages.${system};
  yabridgeWine =
    inputs.yabridge-flake.inputs.nixpkgs.legacyPackages.${system}.wineWow64Packages.staging;

  wineXln = pkgs.writeShellApplication {
    name = "wine-xln";
    runtimeInputs = [
      pkgs.coreutils
      yabridgeWine
    ];
    text = ''
      if (( $# == 0 )); then
        echo 'Usage: wine-xln "path/to/XLN Online Installer.exe" [arguments...]' >&2
        exit 1
      fi

      export WINEPREFIX="''${WINEPREFIX:-$HOME/.wine}"

      # Let Wine initialise or upgrade the prefix before supplying native DLLs.
      wineboot --init

      # JUCE 8's VBlank thread hangs on Wine's unimplemented WaitForVBlank.
      # Supply DXVK in system32 so XLN's downloaded and installed executables
      # can also find it. Only the 64-bit installer needs these DLLs.
      for dll in dxgi d3d11 d3d10core; do
        cp --remove-destination "${pkgs.dxvk.bin}/x64/$dll.dll" \
          "$WINEPREFIX/drive_c/windows/system32/$dll.dll"
      done

      # Child processes inherit the override across XLN's self-update/restart.
      # Do not change the prefix's registry overrides for other applications.
      export WINEDLLOVERRIDES='dxgi,d3d11,d3d10core=n'
      export DXVK_LOG_PATH="$WINEPREFIX"
      exec wine "$@"
    '';
  };

  applyReaperSettings = pkgs.writeShellApplication {
    name = "apply-reaper-settings";
    runtimeInputs = with pkgs; [
      coreutils
      crudini
      procps
    ];
    text = ''
      reaper_config_dir="''${XDG_CONFIG_HOME:-$HOME/.config}/REAPER"
      reaper_config_file="$reaper_config_dir/reaper.ini"
      plugin_link="$HOME/.lv2/neural_amp_modeler.lv2"

      # Nix's wrapper runs the actual executable as .reaper-wrapped.
      if pgrep --uid "$(id --user)" --exact 'reaper|\.reaper-wrapped' >/dev/null; then
        echo "Reaper is running; settings were not changed" >&2
        exit 1
      fi

      # Only replace symlinks, never a manually installed plugin bundle.
      if [[ -e $plugin_link && ! -L $plugin_link ]]; then
        echo "Refusing to replace $plugin_link: not a symlink" >&2
        exit 1
      fi

      mkdir -p "$reaper_config_dir" "$HOME/.lv2"
      touch "$reaper_config_file"

      # Note: Reaper shall be configured to use ALSA directly, not through
      # pipewire or jack. Doing this has proven to give the lowest latency
      # without any buffer xruns (i.e. crackling noises).
      # Configure Reaper for:
      # - Setting the real-time priority to be below the USB IRQ (see musnix config below)
      # - Set the audio interface to use 3x128 buffers. This has the best latency without
      #   buffer xruns (crackling)
      # - Disable power management using the udev rules set by musnix. More info:
      #     - https://github.com/musnix/musnix/blob/8548782f0d1d0928daa3fffde8a008f72219a3f3/modules/base.nix#L139
      #     - https://wiki.linuxaudio.org/wiki/system_configuration#quality_of_service_interface
      crudini --set "$reaper_config_file" reaper alsa_rtprio 80
      crudini --set "$reaper_config_file" reaper linux_audio_bsize 128
      crudini --set "$reaper_config_file" reaper linux_audio_bufs 3
      crudini --set "$reaper_config_file" reaper linux_disable_pm 1

      ln -sfnT ${pkgs.neural-amp-modeler-lv2}/lib/lv2/neural_amp_modeler.lv2 "$plugin_link"

      echo "Applied declarative Reaper settings"
    '';
  };
in
{
  # Apply mutable Reaper settings before the user's normal session starts.
  # Run `apply-reaper-settings` manually after closing Reaper to reapply them
  # without logging out.
  systemd.user.services.apply-reaper-settings = {
    description = "Apply declarative Reaper settings";
    wantedBy = [ "default.target" ];
    before = [ "default.target" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${applyReaperSettings}/bin/apply-reaper-settings";
    };
  };

  # Use MusNix for real-time kernel configuration.
  musnix = {
    enable = true;
    rtcqs.enable = true;
    kernel.realtime = true;
    rtirq = {
      enable = true;
      resetAll = 1;
      # USB audio uses the shared xHCI controller IRQ rather than a dedicated
      # snd IRQ. Prioritise that controller and leave the unused PCI HDA and RTC
      # IRQ threads at their kernel defaults.
      nameList = "usb";
      # Set the thread priorty in the DAW to be just this below value.
      prioHigh = 90;
      prioDecr = 5;
    };
  };

  # This has shown to yield much better performance when running the plugins
  # under Wine. Without it, the DAW would momentarily lock-up during playback
  # or recording when I had a few Helix Native instances running.
  boot.kernelModules = [ "ntsync" ];

  environment.systemPackages = with pkgs; [
    # DAW
    alsa-utils
    applyReaperSettings
    qpwgraph
    reaper

    # Native plugins
    neural-amp-modeler-lv2

    # Bridging Windows plugins
    yabridgePkgs.yabridge
    yabridgePkgs.yabridgectl
    yabridgeWine
    wineXln
  ];
}
