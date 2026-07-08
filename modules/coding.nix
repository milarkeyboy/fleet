{ lib, pkgs, ... }:

{
  environment.systemPackages = with pkgs; [
    # Agents
    pi-coding-agent

    # LSPs
    clang-tools
    nixd
    typescript-language-server
    rust-analyzer
  ];
}
