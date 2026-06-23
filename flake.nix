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
          ];
        };
    in
    {
      # Public build targets. Add new machines here after creating a matching
      # top-level host file.
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
