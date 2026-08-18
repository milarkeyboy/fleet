{ inputs, pkgs, ... }:

let
  unstablePkgs = inputs.nixpkgs-unstable.legacyPackages.${pkgs.stdenv.hostPlatform.system};
in
{
  environment.systemPackages = with pkgs; [
    # Agents
    unstablePkgs.pi-coding-agent

    # LSPs
    clang-tools
    nixd
    typescript-language-server
    rust-analyzer

    # Other editor tools
    tree-sitter
  ];
}
