{ pkgs, ... }:

{
  imports = [
    ./hardware-configurations/desktop.nix

    ./modules/base.nix
    ./modules/daw.nix
    ./modules/element.nix
    ./modules/workstation.nix
    ./modules/desktop-environment/hyprland.nix
    ./modules/coding.nix
    ./modules/gaming.nix

    ./users/mitch.nix
  ];

  networking.hostName = "desktop";

  # RX 9070: use the kernel's amdgpu driver with Mesa's RadeonSI/RADV drivers.
  # modules/gaming.nix supplies Mesa for both native and 32-bit games.
  services.xserver.videoDrivers = [ "amdgpu" ];
  hardware.amdgpu.initrd.enable = true;

  # This host has one 4K display. Use its connector name if more are added.
  environment.etc."xdg/hypr/conf.d/outputs.lua".text = ''
    hl.monitor({ output = "", mode = "3840x2160@60", position = "auto", scale = 1.5 })
  '';

  # The TUI greeter uses the console font rather than Wayland output scaling.
  console = {
    packages = [ pkgs.terminus_font ];
    font = "ter-v32n";
  };
}
