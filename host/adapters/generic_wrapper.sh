# VibeStick generic wrapper for any AI CLI (codex, opencode, kimi, ...).
#
# Source this file from your shell rc, then use `vibe_wrap <cmd> [args...]`.
# It drops a STATUS-schema JSON file into ~/.vibestick/sessions/ so the tool
# shows up on the device: state "running" while the command runs, then
# "idle" on exit. A `tmux` (preferred) or `tty` delivery field is added so
# messages from the device can be typed back into the session.
#
# Example:
#   . /path/to/host/adapters/generic_wrapper.sh
#   vibe_wrap codex

VIBESTICK_STATE_DIR="${VIBESTICK_STATE_DIR:-$HOME/.vibestick/sessions}"

vibe_wrap() {
    _vw_tool="$1"; shift
    mkdir -p "$VIBESTICK_STATE_DIR" || return 1
    _vw_id="$_vw_tool-$$"
    _vw_file="$VIBESTICK_STATE_DIR/$_vw_id.json"

    # Delivery field fragments (leading comma, empty when unknown).
    # tmux wins at resolve time; zellij is recorded alongside it.
    _vw_extra=""
    if [ -n "$TMUX_PANE" ]; then
        _vw_extra="$_vw_extra, \"tmux\": \"$TMUX_PANE\""
    fi
    if [ -n "$ZELLIJ" ] && [ -n "$ZELLIJ_SESSION_NAME" ]; then
        _vw_extra="$_vw_extra, \"zellij\": \"$ZELLIJ_SESSION_NAME\""
        [ -n "$ZELLIJ_PANE_ID" ] \
            && _vw_extra="$_vw_extra, \"zellij_pane\": \"$ZELLIJ_PANE_ID\""
    fi
    if [ -z "$TMUX_PANE" ] && [ -z "$ZELLIJ" ]; then
        _vw_tty=$(tty 2>/dev/null || true)
        [ -n "$_vw_tty" ] && [ "$_vw_tty" != "not a tty" ] \
            && _vw_extra="$_vw_extra, \"tty\": \"$_vw_tty\""
    fi

    _vw_write() { # $1 = state, $2 = last
        printf '{"id": "%s", "tool": "%s", "model": "", "session": "%s", "state": "%s", "ctx_pct": -1, "cost_usd": -1, "last": "%s", "updated": %s%s}\n' \
            "$_vw_id" "$_vw_tool" "$(basename "$PWD")" "$1" "$2" "$(date +%s)" "$_vw_extra" > "$_vw_file"
    }

    _vw_write running ""
    "$_vw_tool" "$@"
    _vw_rc=$?
    _vw_write idle "exited ($_vw_rc)"
    return $_vw_rc
}
