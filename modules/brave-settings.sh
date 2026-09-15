#!/usr/bin/env bash

set -euo pipefail

settings_dir=$1
user_data_dir="${XDG_CONFIG_HOME:-$HOME/.config}/BraveSoftware/Brave-Browser"
temporary_files=()

cleanup() {
  rm -f "${temporary_files[@]}"
}
trap cleanup EXIT

if pgrep --uid "$(id --user)" --exact brave >/dev/null; then
  echo "Brave is running; settings were not changed" >&2
  exit 1
fi

while IFS= read -r -d '' overlay; do
  relative_path=${overlay#"$settings_dir/"}
  destination="$user_data_dir/$relative_path"
  destination_dir=$(dirname "$destination")

  mkdir --parents "$destination_dir"

  if [[ ! -e $destination ]]; then
    printf '{}\n' >"$destination"
    chmod 600 "$destination"
  fi

  temporary_file=$(mktemp --tmpdir="$destination_dir" .fleet-brave-settings.XXXXXX)
  temporary_files+=("$temporary_file")

  jq --slurpfile overlay "$overlay" '. * $overlay[0]' \
    "$destination" >"$temporary_file"

  chmod --reference="$destination" "$temporary_file"
  mv "$temporary_file" "$destination"
done < <(find "$settings_dir" -type f -print0)

echo "Applied declarative Brave settings"
