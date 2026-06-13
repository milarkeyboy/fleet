{ pkgs, username, ... }:

{
  users.users.${username} = {
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
}
