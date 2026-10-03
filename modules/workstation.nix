{ pkgs, inputs, ... }:

{
  imports = [
    ./brave.nix
  ];

  # Devices and peripherals.
  hardware.bluetooth.enable = true;
  services.blueman.enable = true;
  services.printing.enable = true;

  # PipeWire is the default workstation audio stack.
  security.rtkit.enable = true;
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    alsa.support32Bit = true;
    pulse.enable = true;
  };

  # Workstation packages are available to every user on interactive machines.
  environment.systemPackages = with pkgs; [
    # TUI Spotify player
    inputs.spotatui.packages.${pkgs.stdenv.hostPlatform.system}.default
  ];
}
