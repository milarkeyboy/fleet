{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:

# Module for running a DAW:
# - Reaper is the DAW of choice, and home manager is used to configure it.
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
  cfg = config.fleet.daw;
  system = pkgs.stdenv.hostPlatform.system;
  yabridgePkgs = inputs.yabridge-flake.packages.${system};
  yabridgeWine = inputs.yabridge-flake.inputs.nixpkgs.legacyPackages.${system}.wineWow64Packages.staging;

  # Note: Reaper shall be configured to use ALSA directly, not through
  # piprewire or jack. Doing this has proven to give the lowest latency
  # without any buffer xruns (i.e. crackling noises).
  userDawConfig =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      reaperConfigDirectory = "${config.xdg.configHome}/REAPER";
      reaperConfigFile = "${reaperConfigDirectory}/reaper.ini";
    in
    {
      # Configure Reaper for:
      # - Setting the real-time priority to be below the USB IRQ (see musnix config below)
      # - Set the audio interface to use 3x128 buffers. This has the best latency without
      #   buffer xruns (crackling)
      # - Disable power management using the udev rules set by musnix. More info:
      #     - https://github.com/musnix/musnix/blob/8548782f0d1d0928daa3fffde8a008f72219a3f3/modules/base.nix#L139
      #     - https://wiki.linuxaudio.org/wiki/system_configuration#quality_of_service_interface
      home.activation.configureDawAudio = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        run mkdir -p ${lib.escapeShellArg reaperConfigDirectory}
        run touch ${lib.escapeShellArg reaperConfigFile}
        run ${pkgs.crudini}/bin/crudini --set ${lib.escapeShellArg reaperConfigFile} reaper alsa_rtprio 80
        run ${pkgs.crudini}/bin/crudini --set ${lib.escapeShellArg reaperConfigFile} reaper linux_audio_bsize 128
        run ${pkgs.crudini}/bin/crudini --set ${lib.escapeShellArg reaperConfigFile} reaper linux_audio_bufs 3
        run ${pkgs.crudini}/bin/crudini --set ${lib.escapeShellArg reaperConfigFile} reaper linux_disable_pm 1
      '';
    };
in
{
  # Provide an option for configuring Reaper for each of the given users.
  # This allows this module to setup the Reaper config file settings that
  # relate to having low-latency audio working.
  options.fleet.daw.users = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    default = [ ];
    description = "Users whose Home Manager configuration should include user-scoped DAW settings.";
  };

  config = {
    # Apply the reaper settings to each user using Home Manager.
    home-manager.users = lib.genAttrs cfg.users (_: {
      imports = [ userDawConfig ];
    });

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
      qpwgraph
      reaper

      # Bridging Windows plugins
      yabridgePkgs.yabridge
      yabridgePkgs.yabridgectl
      yabridgeWine
    ];
  };
}
