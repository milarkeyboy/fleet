{ lib, pkgs, ... }:

{
  # Boot defaults assume UEFI and systemd-boot. Override these in a host if a
  # machine needs GRUB, BIOS boot, or a custom boot setup.
  boot.loader.systemd-boot.enable = lib.mkDefault true;
  boot.loader.efi.canTouchEfiVariables = lib.mkDefault true;

  # Locale and time defaults are shared across the fleet. Add host overrides
  # only for machines that need different regional settings.
  console.keyMap = lib.mkDefault "us";
  i18n.defaultLocale = lib.mkDefault "en_AU.UTF-8";
  time.timeZone = lib.mkDefault "Australia/Adelaide";

  # NetworkManager is the default networking stack for now because most target
  # machines are interactive. Server-specific networking can override this.
  networking.networkmanager.enable = lib.mkDefault true;

  # Nix settings apply to every machine. Add cache, substituter, or garbage
  # collection policy here when those become fleet-wide decisions.
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

  # nixpkgs settings affect evaluation for every host. Keep broad policy here;
  # put package selections in the role modules below.
  nixpkgs = {
    config.allowUnfree = true;
    hostPlatform = lib.mkDefault "x86_64-linux";
  };

  # Universal system tools should be useful on every machine, including root
  # shells and recovery sessions. Role-specific tools belong elsewhere.
  environment.systemPackages = with pkgs; [
    git
    neovim
    codex
  ];

  # Enable zsh system-wide so it can be used as an account login shell. User
  # aliases and prompts belong in Home Manager.
  programs.zsh.enable = true;

  # State version pins compatibility defaults. Do not bump this just because
  # the NixOS input changes; only change it after reading the release notes.
  system.stateVersion = "26.05";
}
