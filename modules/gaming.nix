{ lib, pkgs, ... }:

{
  # Steam.
  programs.steam = {
    enable = true;
    extraCompatPackages = [
      pkgs.proton-ge-bin
    ];
  };

  # Enable OpenGL, Vulkan, etc.
  hardware.graphics.enable = true;
  hardware.graphics.enable32Bit = true;

  # Game mode for optimisation.
  programs.gamemode.enable = true;
}

