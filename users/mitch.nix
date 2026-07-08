{ pkgs, ... }:

{
  # System account capabilities belong with the user so host files can choose
  # their user set directly.
  users.users.mitch = {
    isNormalUser = true;
    description = "Mitch";
    extraGroups = [
      "audio"
      "networkmanager"
      "video"
      "wheel"
    ];
    shell = pkgs.zsh;
  };

  # Allow the DAW module to configure dotfiles (see modules/daw.nix).
  fleet.daw.users = [ "mitch" ];

  # Home Manager owns Mitch's interactive user environment. Keep machine-wide
  # packages and services in modules/*.nix instead.
  home-manager.users.mitch = {
    home.username = "mitch";
    home.homeDirectory = "/home/mitch";
    home.stateVersion = "26.05";

    # User-scoped packages belong here when they support Mitch's interactive
    # shell rather than the whole machine. Shared tools such as ripgrep, fd,
    # and jq live in the workstation module instead.
    home.packages = with pkgs; [
      eza
      fzf
    ];

    programs.home-manager.enable = true;

    # Git
    programs.git = {
      enable = true;
      settings = {
        init.defaultBranch = "main";
        pull.rebase = false;
        user = {
          name = "Mitchell Larkin";
          email = "mitchlarkin12@gmail.com";
        };
      };
    };

    # Neovim
    xdg.configFile."nvim" = {
      source = ./mitch/nvim;
      recursive = true;
    };

    # Shell
    programs.zsh = {
      enable = true;
      autosuggestion.enable = true;
      syntaxHighlighting.enable = true;
      shellAliases = {
        ll = "ls -lah";
        ls = "eza";
      };
    };
  };
}
