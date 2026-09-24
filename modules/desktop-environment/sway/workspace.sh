# Follow Manjaro's numbered workspace selection, including the current workspace
# when it is empty. Floating windows also make a workspace occupied.
workspace=$(swaymsg -t get_tree -r | jq -er '
    [.. | objects | select(.type? == "workspace" and .name != "__i3_scratch")] as $workspaces
    | ($workspaces | map(select(any(.. | objects; .focused? == true))) | first) as $current
    | if $current == null then error("No focused workspace") else
        ([range(1; 11)] - [$workspaces[].num]
            + [$current | select(.nodes == [] and .floating_nodes == []) | .num])
        | min // $current.num
      end
')

case "${1:-}" in
    switch) command="workspace number $workspace" ;;
    move) command="move container to workspace number $workspace" ;;
    move-and-switch)
        # A single IPC command avoids an intermediate redraw between the actions.
        command="move container to workspace number $workspace, workspace number $workspace"
        ;;
    *) printf 'Usage: fleet-workspace {switch|move|move-and-switch}\n' >&2; exit 1 ;;
esac

swaymsg -r "$command" | jq -e 'all(.[]; .success)' > /dev/null
