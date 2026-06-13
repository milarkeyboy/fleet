{ pkgs, ... }:

{
  services.openssh = {
    enable = true;
    openFirewall = true;
  };

  environment.systemPackages = with pkgs; [
    btop
    git
    tmux
    vim
  ];
}
