# Query the daemon rather than caching state, so scheduled changes are visible.
identity=$(timeout 2 hyprctl hyprsunset identity get 2>/dev/null) || identity=unavailable

case "${1:-status}" in
    status)
        case "$identity" in
            true) printf 'disabled\n' ;;
            false) printf 'enabled\n' ;;
            *) printf 'unavailable\n' ;;
        esac
        ;;
    toggle)
        case "$identity" in
            true) reply=$(timeout 2 hyprctl hyprsunset temperature 3500) ;;
            false) reply=$(timeout 2 hyprctl hyprsunset identity) ;;
            *) exit 1 ;;
        esac
        # IPC can report a command error even when the client exits successfully.
        [[ "$reply" == "ok" ]]
        ;;
    *)
        printf 'Usage: fleet-blue-light [status|toggle]\n' >&2
        exit 1
        ;;
esac
