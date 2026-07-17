{ pkgs, ... }:

{
  # DAW tooling is installed system-wide for the home desktop. Windows plugin
  # DLLs and yabridge-generated wrappers remain user-managed state outside this
  # repository.
  services.pipewire = {
    jack.enable = true;

    # PipeWire's quantum is the JACK buffer-size equivalent. Keep 128/48000 as
    # the default low-latency recording setup, while still allowing runtime
    # overrides with pw-metadata for heavier projects.
    extraConfig.pipewire."92-low-latency" = {
      "context.properties" = {
        "default.clock.rate" = 48000;
        "default.clock.quantum" = 256;
        "default.clock.min-quantum" = 256;
        "default.clock.max-quantum" = 256;
      };
    };
  };

  musnix = {
    enable = true;
    rtcqs.enable = true;
    kernel.realtime = true;
    rtirq.enable = true;
  };

  environment.systemPackages = with pkgs; [
    alsa-utils
    qpwgraph
    reaper
    wineWow64Packages.stagingFull
    winetricks
    yabridge
    yabridgectl
  ];

  # After installing or copying Windows VST plugins into the Wine prefix, run:
  #
  #   yabridgectl add "$HOME/.wine/drive_c/Program Files/Common Files/VST3"
  #   yabridgectl add "$HOME/.wine/drive_c/Program Files/Common Files/CLAP"
  #   yabridgectl add "$HOME/.wine/drive_c/Program Files/VstPlugins"
  #   yabridgectl sync
  #
  # Then scan ~/.vst, ~/.vst3, and ~/.clap from REAPER as needed.
  #
  # Test other latency settings at runtime before making them global:
  #
  #   pw-metadata -n settings 0 clock.force-rate 48000
  #   pw-metadata -n settings 0 clock.force-quantum 128
  #
  # Use 256 if 128 crackles, 64 for lower-latency experiments, and reset either
  # setting with value 0. A force-quantum value of 0 means the configured default
  # is active. A full logout or reboot is required after changing the realtime
  # limits above.
}
