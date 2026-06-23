{ pkgs, ... }:

{
  # Workstations currently use KDE Plasma. Replace this block when changing the
  # chosen desktop environment; split it out only if multiple desktops are real.
  services.xserver = {
    enable = true;
    xkb = {
      layout = "au";
      variant = "";
    };
  };
  services.displayManager.sddm.enable = true;
  services.desktopManager.plasma6.enable = true;

  # Interactive machines should support local peripherals. Add workstation-wide
  # device services here rather than duplicating them per host.
  hardware.bluetooth.enable = true;
  services.blueman.enable = true;
  services.printing.enable = true;

  # PipeWire is the default workstation audio stack. Add JACK, pro-audio, or
  # interface-specific settings here when they apply across workstations.
  security.rtkit.enable = true;
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    alsa.support32Bit = true;
    pulse.enable = true;
  };

  # SSH agent support is useful for interactive development machines. Move or
  # override this if a workstation should not keep an agent.
  programs.ssh.startAgent = true;

  # Workstation packages are available to every user on interactive machines.
  # Keep this list audited; use Home Manager only for Mitch-specific tools.
  environment.systemPackages = with pkgs; [
    bat
    btop
    fd
    file
    firefox
    gh
    jq
    pciutils
    ripgrep
    tree
    unzip
    usbutils
    zip
  ];
}
