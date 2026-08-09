{ pkgs, ... }:

{
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

  home-manager.users.mitch = { config, ... }: {
    home.username = "mitch";
    home.homeDirectory = "/home/mitch";
    home.stateVersion = "26.05";

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
    xdg.configFile."nvim".source =
      config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/fleet/users/mitch/nvim";

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
