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

    # Git behavior is user preference, so it belongs in Home Manager even
    # though git itself is also available system-wide for root and non-Home
    # shells.
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

    # Editor preferences are user-level defaults. Add plugin wiring here later,
    # while keeping larger Lua configuration in Lua files imported by Nix.
    programs.neovim = {
      enable = true;
      defaultEditor = true;
      viAlias = true;
      vimAlias = true;
    };

    # Home Manager configures the interactive shell experience. The system user
    # config above separately chooses zsh as the login shell.
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
