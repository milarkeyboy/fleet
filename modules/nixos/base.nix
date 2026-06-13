{ lib, pkgs, ... }:

{
  boot.loader.systemd-boot.enable = lib.mkDefault true;
  boot.loader.efi.canTouchEfiVariables = lib.mkDefault true;

  console.keyMap = lib.mkDefault "us";
  i18n.defaultLocale = lib.mkDefault "en_AU.UTF-8";
  time.timeZone = lib.mkDefault "Australia/Adelaide";

  networking.networkmanager.enable = lib.mkDefault true;

  nix = {
    settings.experimental-features = [
      "nix-command"
      "flakes"
    ];
    gc = {
      automatic = true;
      dates = "weekly";
      options = "--delete-older-than 14d";
    };
  };

  nixpkgs = {
    config.allowUnfree = true;
    hostPlatform = lib.mkDefault "x86_64-linux";
  };

  environment.systemPackages = with pkgs; [
    curl
    git
    vim
    wget
  ];

  programs.zsh.enable = true;

  system.stateVersion = "26.05";
}
