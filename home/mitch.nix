{ pkgs, username, ... }:

{
  # Home identity tells Home Manager which account it is managing. Change this
  # only if the primary user or home directory convention changes.
  home.username = username;
  home.homeDirectory = "/home/${username}";
  home.stateVersion = "26.05";

  # User-scoped packages belong here when they support Mitch's interactive
  # shell rather than the whole machine. Shared tools such as ripgrep, fd, and
  # jq live in the workstation module instead to avoid duplicate package lists.
  home.packages = with pkgs; [
    eza
    fzf
  ];

  # Enables Home Manager to manage itself for this user.
  programs.home-manager.enable = true;

  # Git behavior is user preference, so it belongs in Home Manager even though
  # git itself is also available system-wide for root and non-Home shells.
  programs.git = {
    enable = true;
    extraConfig = {
      init.defaultBranch = "main";
      pull.rebase = false;
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
  # module separately chooses zsh as the login shell.
  programs.zsh = {
    enable = true;
    autosuggestion.enable = true;
    syntaxHighlighting.enable = true;
    shellAliases = {
      ll = "ls -lah";
      ls = "eza";
    };
  };
}
