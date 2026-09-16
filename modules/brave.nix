{ pkgs, ... }:

let
  localState = pkgs.writeText "brave-local-state.json" (
    builtins.toJSON {
      brave.ad_block = {
        checked_all_default_regions = true;

        # UUIDs and descriptions come from Brave's filter-list catalogue:
        # https://github.com/brave/adblock-resources/blob/master/filter_lists/list_catalog.json
        regional_filters = {
          # Cookie notice blocker
          "AC023D22-AE88-4060-A978-4FEEEC4221693".enabled = true;
          # Annoying distractions blocker
          "67E792D4-AE03-4D1A-9EDE-80E01C81F9B8".enabled = true;
          # AI suggestions blocker
          "6b91e355-1421-4c03-9a30-911b4d0fb277".enabled = true;
          # Newsletter popup blocker
          "690FF3B4-8B6B-4709-8505-FEC6643D7BD9".enabled = true;
          # Mobile app promo blocker
          "2F3DCE16-A19A-493C-A88F-2E110FBD37D6".enabled = true;
          # YouTube Shorts blocker
          "9E8EC586-4E17-4E5E-99D7-35172C4CEA74".enabled = true;
          # YouTube recommendations blocker (mobile-only)
          "2D57ADED-3531-419A-9DED-7F8868BC1561".enabled = true;
          # YouTube end video elements blocker
          "d579f370-6de3-4507-aa9a-cee4227e59f5".enabled = true;
          # Tracking URL blocker
          "E2FA7D98-0BD5-493E-8AF4-950604ADE9CB".enabled = true;
          # Chat app blocker
          "1ED1870B-997C-4BFE-AEBC-B67D679BAF3B".enabled = true;
          # Paywall blocker
          "78672887-A098-4D2C-B0CB-A3DEC4834DA7".enabled = true;
          # Experimental ad blocker
          "564C3B75-8731-404C-AD7C-5683258BA0B0".enabled = true;
        };
      };
    }
  );

  preferences = pkgs.writeText "brave-preferences.json" (
    builtins.toJSON {
      # Aggressive content filtering
      profile.content_settings.exceptions = {
        shieldsAds."*,*".setting = 2;
        trackers."*,*".setting = 2;
        cosmeticFiltering."*,*".setting.cosmeticFiltering = 1;
      };

      brave = {
        # Show blank page on new tab
        new_tab_page.show_options = 2;
        # Obviously don't want that
        rewards.show_brave_rewards_button_in_location_bar = false;
      };
    }
  );

  braveSettings = pkgs.runCommand "brave-settings" { } ''
    mkdir --parents "$out/Default"
    cp ${localState} "$out/Local State"
    cp ${preferences} "$out/Default/Preferences"
  '';

  applyBraveSettings = pkgs.writeShellApplication {
    name = "apply-brave-settings";
    runtimeInputs = with pkgs; [
      coreutils
      findutils
      jq
      procps
    ];
    text = ''
      exec ${pkgs.bash}/bin/bash ${./brave-settings.sh} ${braveSettings}
    '';
  };
in
{
  environment.systemPackages = [
    applyBraveSettings
    pkgs.brave
  ];

  # Apply mutable Brave settings before the user's normal session starts.
  # Run `apply-brave-settings` manually after closing Brave to reapply them
  # without logging out.
  systemd.user.services.apply-brave-settings = {
    description = "Apply declarative Brave settings";
    wantedBy = [ "default.target" ];
    before = [ "default.target" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${applyBraveSettings}/bin/apply-brave-settings";
    };
  };

  # Nix-managed Brave and Chromium policies. These settings appear as managed
  # in Brave and cannot be overridden through the UI.
  programs.chromium = {
    enable = true;

    homepageLocation = "https://search.brave.com/";
    defaultSearchProviderEnabled = true;
    defaultSearchProviderSearchURL = "https://search.brave.com/search?q={searchTerms}";

    # Force-installed Chrome Web Store extensions.
    extensions = [
      # LastPass
      "hdokiejnpimakedhajhdlcegeplioahd"

      # Vimium
      "dbepggeogbaibhgnhhndojpepiihcmeb"
      # Vimium new tab page, to let the hotkeys work without needing to access
      # their own new page URL pointing to their GitHub.
      "leohhkagdnmgbpfbnflhjmnpcjpcjmgm"
    ];

    extraOpts = {
      # Generic Chromium policies.
      AutofillAddressEnabled = false;
      AutofillCreditCardEnabled = false;
      # Allow notifications by default.
      DefaultNotificationsSetting = 1;
      # LastPass is used instead.
      PasswordManagerEnabled = false;
      RestoreOnStartup = 0;
      ShowHomeButton = true;

      # Brave-specific Shields policies.
      # Use standard fingerprinting protection.
      DefaultBraveFingerprintingV2Setting = 3;
      # Prefer HTTPS.
      DefaultBraveHttpsUpgradeSetting = 3;
      BraveGlobalPrivacyControlEnabled = true;
      BraveTrackingQueryParametersFilteringEnabled = true;
    };
  };
}
