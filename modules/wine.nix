{
  lib,
  buildEnv,
  coreutils,
  dxvk,
  util-linux,
  wine,
  writeShellApplication,
}:

let
  launcher = writeShellApplication {
    name = "wine";
    runtimeInputs = [
      coreutils
      util-linux
    ];
    text = ''
      # yabridge also calls wine --version. Queries need no prefix.
      case "''${1:-}" in
        ""|--help|--version) exec ${wine}/bin/wine "$@" ;;
      esac

      export WINEPREFIX="''${WINEPREFIX:-$HOME/.wine}"
      if [[ $WINEPREFIX != /* ]]; then
        echo 'WINEPREFIX must be an absolute path' >&2
        exit 1
      fi
      windows="$WINEPREFIX/drive_c/windows"

      link_dlls() {
        local dll src dest
        for dll in dxgi d3d11 d3d10core; do
          src="${dxvk.bin}/$1/$dll.dll"
          dest="$windows/$2/$dll.dll"
          if [[ ! $src -ef $dest ]]; then
            ln -sfnT "$src" "$dest"
          fi
        done
      }

      # Plugin scans can start several hosts in the same prefix at once.
      (umask 077; mkdir -p "$WINEPREFIX")
      (
        flock -x 9
        if [[ ! -f $WINEPREFIX/system.reg ]]; then
          ${wine}/bin/wineboot --init 9<&-
        fi
        if [[ -d $windows/syswow64 ]]; then
          link_dlls x64 system32
          link_dlls x32 syswow64
        else
          link_dlls x32 system32
        fi
      ) 9<"$WINEPREFIX"

      # Wine honours the last override for each DLL, including a caller's =b.
      export WINEDLLOVERRIDES="dxgi,d3d11,d3d10core=n''${WINEDLLOVERRIDES:+;$WINEDLLOVERRIDES}"
      export DXVK_LOG_PATH="''${DXVK_LOG_PATH:-$WINEPREFIX}"
      exec ${wine}/bin/wine "$@"
    '';
  };
in
# Keep Wine's tools, including the compiler used to build the yabridge host.
buildEnv {
  name = "wine-staging-dxvk";
  paths = [
    (lib.hiPrio launcher)
    wine
  ];
}
