{ pkgs, ... }:

{
  # Steam.
  programs.steam = {
    enable = true;
    extraCompatPackages = [
      pkgs.proton-ge-bin
    ];
  };

  environment.systemPackages = with pkgs; [
    # Console emulator
    dolphin-emu

    # Quake 3, which is better than the engine on
    # Steam. Requires copying the assets to ~/.q3a.
    quake3e

    discord
  ];

  # Enable OpenGL, Vulkan, etc.
  hardware.graphics.enable = true;
  hardware.graphics.enable32Bit = true;

  # Stream the active graphical session to Moonlight clients.
  services.sunshine.enable = true;

  # Game mode for optimisation.
  programs.gamemode.enable = true;
}

