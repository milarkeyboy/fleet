{
  lib,
  stdenv,
  inputs,
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

stdenv.mkDerivation (finalAttrs: {
  pname = "kushview-element";
  version = "1.2.0";
  src = inputs.element-src;

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
    "-DFETCHCONTENT_SOURCE_DIR_JUCE=${inputs.element-juce-src}"
    "-DFETCHCONTENT_SOURCE_DIR_SOL2=${inputs.element-sol2-src}"
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
