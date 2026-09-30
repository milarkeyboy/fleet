{ inputs, pkgs, ... }:

{
  environment.systemPackages = with pkgs; [
    # Agents
    inputs.pi.packages.${pkgs.stdenv.hostPlatform.system}.coding-agent

    # Toolchains
    # Note: tree-sitter needs a C compiler to exist.
    gcc

    # Node + npm
    # Node is used by pi extensions and JavaScript tooling.
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
