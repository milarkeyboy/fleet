{ pkgs, ... }:

{
  imports = [
    ./hardware-configurations/desktop.nix

    ./modules/base.nix
    ./modules/daw.nix
    ./modules/workstation.nix
    ./modules/desktop-environment/sway.nix
    ./modules/coding.nix
    ./modules/gaming.nix

    ./users/mitch.nix
  ];

  networking.hostName = "desktop";

  # The proprietary NVIDIA driver requires an explicit Sway opt-in.
  programs.sway.extraOptions = [ "--unsupported-gpu" ];

  # This host has one 4K display. Use its connector name if more are added.
  environment.etc."sway/config.d/outputs.conf".text = ''
    output * mode 3840x2160@60Hz scale 1.45
  '';

  # The TUI greeter uses the console font rather than Wayland output scaling.
  console = {
    packages = [ pkgs.terminus_font ];
    font = "ter-v32n";
  };

  # Enable NVIDIA driver.
  # Note that the 'xserver' part is just the name of the settings to
  # turn on the NVIDIA driver; it's required for both X11 and Wayland.
  services.xserver.videoDrivers = [ "nvidia" ];
  hardware.nvidia = {
    # The GeForce GTX 1060 uses the driver branch supporting Pascal GPUs:
    # https://nvidia.custhelp.com/app/answers/detail/a_id/3142/~/support-timeframes-for-unix-legacy-gpu-releases
    branch = "legacy_580";
    # Proprietary.
    open = false;

    # Wayland requires modesetting:
    # - https://wiki.nixos.org/wiki/NVIDIA#Wayland
    modesetting.enable = true;
  };
}
