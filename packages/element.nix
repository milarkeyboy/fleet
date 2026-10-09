{
  lib,
  stdenv,
  inputs,
  fetchFromGitHub,
  autoPatchelfHook,
  cmake,
  ninja,
  pkg-config,
  alsa-lib,
  boost,
  curl,
  expat,
  fontconfig,
  freetype,
  ladspa-sdk,
  libGL,
  libjack2,
  libx11,
  libxcomposite,
  libxcursor,
  libxext,
  libxinerama,
  libxrandr,
  libxrender,
  lv2,
  xvfb-run,
}:

let
  # Follow upstream's dependency choices while keeping CMake's build offline.
  cmakeRevision =
    file: variable:
    let
      match = builtins.match ".*set\\(${variable}[[:space:]]+\"?([[:alnum:]._-]+)\"?[[:space:]]*\\).*" (
        builtins.readFile "${inputs.element}/${file}"
      );
    in
    if match == null then
      throw "Element: could not extract ${variable} from ${file}"
    else
      builtins.head match;

  juceSrc = fetchFromGitHub {
    owner = "juce-framework";
    repo = "JUCE";
    rev = cmakeRevision "cmake/FindJUCE.cmake" "ELEMENT_JUCE_VERSION";

    # If hash verification fails after an Element update, replace VERSION below
    # with ELEMENT_JUCE_VERSION from the locked source's cmake/FindJUCE.cmake.
    # Use the returned hash:
    # nix store prefetch-file --json --unpack https://github.com/juce-framework/JUCE/archive/VERSION.tar.gz
    hash = "sha256-TKqW2rsFMAO1HJZ9IFQ7myOzNRScqR0gmLSLQA5Sw28=";
  };

  sol2Src = fetchFromGitHub {
    owner = "ThePhD";
    repo = "sol2";
    rev = cmakeRevision "cmake/FindSol2.cmake" "ELEMENT_SOL2_REVISION";

    # If hash verification fails after an Element update, replace REVISION below
    # with ELEMENT_SOL2_REVISION from the locked source's cmake/FindSol2.cmake.
    # Use the returned hash:
    # nix store prefetch-file --json --unpack https://github.com/ThePhD/sol2/archive/REVISION.tar.gz
    hash = "sha256-0q0ew2ql0ED5ynYPQkq4UHq21VjiqSZTg09XsrrBwqI=";
  };
in
stdenv.mkDerivation (finalAttrs: {
  pname = "kushview-element";
  version = "1.2.0";
  src = inputs.element;

  nativeBuildInputs = [
    autoPatchelfHook
    cmake
    ninja
    pkg-config
  ];

  buildInputs = [
    alsa-lib
    boost
    curl
    expat
    fontconfig
    freetype
    ladspa-sdk
    libGL
    libjack2
    libx11
    libxcomposite
    libxcursor
    libxext
    libxinerama
    libxrandr
    libxrender
    lv2
  ];

  # JUCE and Element load these libraries by name, including in scanner workers.
  # Keep them in each executable's RPATH rather than a launcher's environment.
  runtimeDependencies = map lib.getLib [
    alsa-lib
    curl
    libGL
    libjack2
    libx11
    libxcomposite
    libxcursor
    libxext
    libxinerama
    libxrandr
    libxrender
  ];

  cmakeFlags = [
    "-DFETCHCONTENT_SOURCE_DIR_JUCE=${juceSrc}"
    "-DFETCHCONTENT_SOURCE_DIR_SOL2=${sol2Src}"
    "-DFETCHCONTENT_FULLY_DISCONNECTED=ON"
    "-DSOL2_ENABLE_INSTALL=OFF"
    "-DELEMENT_ENABLE_UPDATER=OFF"
    "-DELEMENT_BUILD_TESTS=ON"

    # Build Element's instrument/effect plugins for use inside another DAW.
    "-DELEMENT_BUILD_PLUGINS=OFF"
    # VST2 hosting/building also requires an SDK at ELEMENT_VST2_SDK_PATH.
    "-DELEMENT_ENABLE_VST2=OFF"
  ];

  # Nix supplies an absolute bindir; upstream's template prefixes it a second time.
  postPatch = ''
    substituteInPlace data/element.desktop.in \
      --replace-fail '@CMAKE_INSTALL_PREFIX@/@CMAKE_INSTALL_BINDIR@/element' \
        '@CMAKE_INSTALL_BINDIR@/element'
  '';

  # JUCE's test harness initialises a GUI even for non-visual unit tests.
  doCheck = true;
  nativeCheckInputs = [ xvfb-run ];
  checkPhase = ''
    runHook preCheck
    export HOME="$TMPDIR/element-test-home"
    mkdir -p "$HOME"
    export LD_LIBRARY_PATH="${lib.makeLibraryPath finalAttrs.runtimeDependencies}"
    xvfb-run ctest --output-on-failure
    runHook postCheck
  '';

  meta = {
    description = "Modular audio and MIDI plugin host";
    homepage = "https://kushview.net/element/";
    license = lib.licenses.gpl3Plus;
    platforms = [ "x86_64-linux" ];
    mainProgram = "element";
  };
})
