{ inputs, pkgs, ... }:

let
  unstablePkgs = inputs.nixpkgs-unstable.legacyPackages.${pkgs.stdenv.hostPlatform.system};
in
{
  environment.systemPackages = with pkgs; [
    # Agents
    unstablePkgs.pi-coding-agent

    # Toolchains
    # Note: tree-sitter needs a C compiler to exist.
    gcc

    # Node + npm
    # Note: this is needed to use pi extensions (see
    # users/mitch/pi/agent/settings.json)
    nodejs_latest

    # LSPs
    clang-tools
    nixd
    typescript-language-server
    rust-analyzer
    pyright
    marksman
    lua-language-server
    mesonlsp

    # Other editor tools
    tree-sitter
  ];
}
