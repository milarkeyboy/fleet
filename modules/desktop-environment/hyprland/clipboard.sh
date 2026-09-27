# All entry points use the same private, session-scoped database. Ignore personal
# cliphist settings here so they cannot redirect captured data to persistent disk.
export CLIPHIST_DB_PATH="${XDG_RUNTIME_DIR:?}/fleet-clipboard/db"
export CLIPHIST_CONFIG_PATH=/dev/null

case "${1:-select}" in
  watch)
    exec wl-paste --watch cliphist store
    ;;
  select)
    selection=$(cliphist list | rofi -dmenu -p Clipboard) || exit 0
    [ -n "$selection" ] || exit 0

    # Decode completely before taking clipboard ownership; cancellation or a
    # stale history entry must leave the current clipboard untouched.
    temporary=$(mktemp "${XDG_RUNTIME_DIR}/fleet-clipboard/selection.XXXXXX")
    trap 'rm -f "$temporary"' EXIT
    printf '%s\n' "$selection" | cliphist decode > "$temporary"
    wl-copy < "$temporary"
    ;;
  clear)
    cliphist wipe
    wl-copy --clear
    ;;
esac
