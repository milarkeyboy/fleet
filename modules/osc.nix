{ pkgsUnstable, ... }:

{
  # Run the OSC/MIDI server with its control interface and editor in a browser.
  environment.systemPackages = [
    pkgsUnstable.open-stage-control-headless
  ];
}
