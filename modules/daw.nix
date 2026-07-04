{ pkgs, ... }:

{
  # Keep the desktop out of low-power CPU scaling while using it as a DAW.
  powerManagement.cpuFreqGovernor = "performance";

  # Match musnix's low-risk baseline tuning without importing the full module.
  boot.kernel.sysctl."vm.swappiness" = 10;

  services.udev.extraRules = ''
    KERNEL=="rtc0", GROUP="audio"
    KERNEL=="hpet", GROUP="audio"
    DEVPATH=="/devices/virtual/misc/cpu_dma_latency", OWNER="root", GROUP="audio", MODE="0660"
  '';

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
        "default.clock.quantum" = 128;
        "default.clock.min-quantum" = 128;
        "default.clock.max-quantum" = 128;
      };
    };
  };

  # JACK clients need realtime scheduling and enough locked memory to run at
  # low latency without failing plugin loads or falling back to non-RT threads.
  security.pam.loginLimits = [
    {
      domain = "@audio";
      type = "-";
      item = "rtprio";
      value = "99";
    }
    {
      domain = "@audio";
      type = "-";
      item = "memlock";
      value = "unlimited";
    }
    {
      domain = "@audio";
      type = "-";
      item = "nice";
      value = "-11";
    }
    {
      domain = "@audio";
      type = "soft";
      item = "nofile";
      value = "1048576";
    }
    {
      domain = "@audio";
      type = "hard";
      item = "nofile";
      value = "1048576";
    }
  ];

  systemd.user.extraConfig = ''
    DefaultLimitRTPRIO=99
    DefaultLimitMEMLOCK=infinity
    DefaultLimitNOFILE=1048576
    DefaultLimitNICE=-11
  '';

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
