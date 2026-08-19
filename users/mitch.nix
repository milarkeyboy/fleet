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

      # OMZ has nice defaults, and autocomplete plugins are helpful. Default
      # p10k behaviour used vim and other stuff, didn't like it.
      oh-my-zsh = {
        enable = true;
        plugins = [
          "git"
        ];
      };

      # Use p10k for theme, since the git prompt is real nice.
      plugins = [
        {
          name = "powerlevel10k";
          src = pkgs.zsh-powerlevel10k;
          file = "share/zsh-powerlevel10k/powerlevel10k.zsh-theme";
        }
      ];
      initContent = ''
        source ${./mitch/p10k.zsh}
      '';

      autosuggestion.enable = true;
      syntaxHighlighting.enable = true;
      shellAliases = {
        ll = "ls -lah";
        ls = "eza";
      };

    };
  };
}
