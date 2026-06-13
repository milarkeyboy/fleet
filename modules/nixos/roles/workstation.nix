{ pkgs, ... }:

{
  imports = [
    ../desktop/kde-plasma.nix
  ];

  services.printing.enable = true;
  programs.ssh.startAgent = true;

  environment.systemPackages = with pkgs; [
    bat
    btop
    fd
    file
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
