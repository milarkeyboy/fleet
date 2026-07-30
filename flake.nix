{
  description = "NixOS and Home Manager configurations for personal machines";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

    home-manager = {
      url = "github:nix-community/home-manager/release-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Convenience flake that sets up all the real-time kernel stuff, and
    # provides nice utilities for getting a DAW up and running.
    musnix.url = "github:musnix/musnix";

    # Use a community flake for yabridge until the Nix package has a more
    # recent build that uses Wine 11+. This allows me to use NTSYNC as a
    # performance bonus:
    # - https://github.com/robbert-vdh/yabridge#performance-tuning
    # - https://github.com/robbert-vdh/yabridge/issues/469
    yabridge-flake.url = "github:noblepayne/yabridge-flake";
  };

  outputs =
    inputs@{ home-manager, nixpkgs, ... }:
    let
      # Shared default for the current fleet. Change this when adding non-x86
      # machines.
      system = "x86_64-linux";

      # Builds one NixOS system from a top-level host selection file. Each host
      # file chooses its hardware module, users, and shared modules.
      mkHost =
        hostname:
        nixpkgs.lib.nixosSystem {
          inherit system;
          specialArgs = {
            inherit inputs;
          };
          modules = [
            (./. + "/${hostname}.nix")
            home-manager.nixosModules.home-manager
            {
              home-manager = {
                useGlobalPkgs = true;
                useUserPackages = true;
                backupFileExtension = "backup";
                extraSpecialArgs = {
                  inherit inputs;
                };
              };
            }
            inputs.musnix.nixosModules.musnix
          ];
        };
    in
    {
      # Each machine has its own configuration for targeting on the
      # command-line.
      nixosConfigurations = {
        desktop = mkHost "desktop";
        laptop = mkHost "laptop";
        "work-laptop" = mkHost "work-laptop";
        server = mkHost "server";
      };

      formatter.${system} = nixpkgs.legacyPackages.${system}.nixfmt-rfc-style;
    };
}
