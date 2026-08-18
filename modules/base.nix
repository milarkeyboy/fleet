{
  config,
  lib,
  pkgs,
  ...
}:

let
  # Limit the number of NixOS generations to avoid bloating disk space.
  generationLimit = 10;
in
{
  # Boot defaults assume UEFI and systemd-boot.
  boot.loader.systemd-boot = {
    enable = lib.mkDefault true;
    configurationLimit = generationLimit;
  };
  boot.loader.efi.canTouchEfiVariables = lib.mkDefault true;

  # Enable NTFS for Windows drives.
  boot.supportedFilesystems = [ "ntfs" ];

  # Locale.
  console.keyMap = lib.mkDefault "us";
  i18n.defaultLocale = lib.mkDefault "en_AU.UTF-8";
  time.timeZone = lib.mkDefault "Australia/Adelaide";

  # Network management.
  networking.networkmanager.enable = lib.mkDefault true;

  # Nix settings.
  nix = {
    settings.experimental-features = [
      "nix-command"
      "flakes"
    ];
  };
  nixpkgs = {
    config.allowUnfree = true;
  };

  # Keep the latest ten system generations and collect unreachable store paths
  # whenever a configuration is switched.
  system.activationScripts.pruneOldGenerations.text = ''
    if [ "$NIXOS_ACTION" = switch ]; then
      ${config.nix.package}/bin/nix-env \
        --profile /nix/var/nix/profiles/system \
        --delete-generations +${toString generationLimit}
      ${config.nix.package}/bin/nix-store --gc
    fi
  '';

  # Nerdfont for TUI goodness.
  fonts = {
    packages = with pkgs; [
      nerd-fonts.jetbrains-mono
    ];
    fontconfig.defaultFonts.monospace = [
      "JetBrainsMono Nerd Font Mono"
    ];
  };

  # Universal system tools should be useful on every machine.
  programs.git.enable = true;
  programs.neovim = {
    enable = true;
    defaultEditor = true;
    viAlias = true;
    vimAlias = true;
  };

  # Enable zsh system-wide so it can be used as an account login shell. User
  # aliases and prompts belong in Home Manager.
  programs.zsh.enable = true;

  # State version pins compatibility defaults. Do not bump this just because
  # the NixOS input changes; only change it after reading the release notes.
  system.stateVersion = "26.05";
}
