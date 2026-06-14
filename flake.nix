{
  description = "NixOS and Home Manager configurations for personal machines";

  # Inputs pin the external projects this repository is built from. Update
  # these when moving to a newer stable NixOS release or adding another flake.
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

    home-manager = {
      url = "github:nix-community/home-manager/release-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs@{ home-manager, nixpkgs, ... }:
    let
      # Shared defaults for the current fleet. Change these when adding
      # non-x86 machines or renaming the primary managed user.
      system = "x86_64-linux";
      username = "mitch";

      # Builds one NixOS system from a host folder and the shared Home Manager
      # wiring. Add host-specific behavior in hosts/<name>/configuration.nix.
      mkHost =
        hostname:
        nixpkgs.lib.nixosSystem {
          inherit system;
          specialArgs = {
            inherit inputs username;
          };
          modules = [
            (./. + "/hosts/${hostname}/configuration.nix")
            home-manager.nixosModules.home-manager
            {
              # Home Manager owns user-level program configuration. Keep
              # machine-wide packages and services in modules/*.nix instead.
              home-manager = {
                useGlobalPkgs = true;
                useUserPackages = true;
                backupFileExtension = "backup";
                extraSpecialArgs = {
                  inherit inputs username;
                };
                users.${username} = import (./. + "/home/${username}.nix");
              };
            }
          ];
        };
    in
    {
      # Public build targets. Add new machines here after creating
      # hosts/<name>/configuration.nix.
      nixosConfigurations = {
        desktop = mkHost "desktop";
        laptop = mkHost "laptop";
        "work-laptop" = mkHost "work-laptop";
        server = mkHost "server";
      };

      # Formatter exposed for future `nix fmt` use once Nix is installed.
      formatter.${system} = nixpkgs.legacyPackages.${system}.nixfmt-rfc-style;
    };
}
