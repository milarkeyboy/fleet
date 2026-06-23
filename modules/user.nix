{ pkgs, username, ... }:

{
  # The primary human user for managed machines. Add groups here when they are
  # broad user capabilities; put machine-specific access in host configs.
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
