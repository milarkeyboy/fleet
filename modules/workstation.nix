{ pkgs, ... }:

{
  # Desktop environment.
  services.displayManager.sddm.enable = true;
  services.desktopManager.plasma6.enable = true;

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

  # Enable SSH agent
  programs.ssh = {
    startAgent = true;
    # Add a key to ssh-agent after its passphrase is entered successfully.
    extraConfig = ''
      AddKeysToAgent yes
    '';
  };

  # Workstation packages are available to every user on interactive machines.
  environment.systemPackages = with pkgs; [
    # Apps
    brave

    # Command line utilities
    bat
    btop
    fd
    file
    jq
    pciutils
    ripgrep
    tree
    unzip
    usbutils
    zip
  ];
}
