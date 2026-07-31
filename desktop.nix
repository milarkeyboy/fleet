{ ... }:

{
  imports = [
    ./hardware-configurations/desktop.nix
    ./modules/base.nix
    ./modules/daw.nix
    ./modules/workstation.nix
    ./modules/coding.nix
    ./users/mitch.nix
  ];

  networking.hostName = "desktop";

  # Enable NVIDIA driver.
  # Note that the 'xserver' part is just the name of the settings to
  # turn on the NVIDIA driver; it's required for both X11 and Wayland.
  services.xserver.videoDrivers = [ "nvidia" ];
  hardware.nvidia = {
    # The GeForce GTX 1060 uses the driver branch supporting Pascal GPUs.
    branch = "legacy_580";
    # Proprietary.
    open = false;

    # Wayland requires modesetting:
    # - https://wiki.nixos.org/wiki/NVIDIA#Wayland
    modesetting.enable = true;
  };
}
