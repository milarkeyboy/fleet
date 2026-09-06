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

    # LSPs
    clang-tools
    nixd
    typescript-language-server
    rust-analyzer
    pyright

    # Other editor tools
    tree-sitter
  ];
}
