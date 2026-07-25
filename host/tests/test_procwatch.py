import json
import time

from vibestick.config import Config, FeaturesConfig, ToolConfig
from vibestick.discover import DiscoveredSession
from vibestick.procwatch import ProcInfo, ProcessWatcher
from vibestick.store import SessionStore


# -- ProcessWatcher against a fake /proc tree -------------------------------


def make_proc(tmp_path, pid, cmdline: bytes, cwd_name=None, exe=None):
    pid_dir = tmp_path / "proc" / str(pid)
    pid_dir.mkdir(parents=True, exist_ok=True)
    (pid_dir / "cmdline").write_bytes(cmdline)
    if cwd_name:
        work = tmp_path / cwd_name
        work.mkdir(exist_ok=True)
        (pid_dir / "cwd").symlink_to(work)
    if exe:
        (pid_dir / "exe").symlink_to(exe)  # dangling is fine: readlink only
    return pid_dir


def test_scan_matches_exe_basename(tmp_path):
    make_proc(tmp_path, 4321, b"/usr/local/bin/codex\0--json\0", cwd_name="myproj")
    make_proc(tmp_path, 4322, b"/bin/bash\0")  # not interesting
    (tmp_path / "proc" / "self").mkdir(parents=True, exist_ok=True)  # non-pid entry
    watcher = ProcessWatcher(tmp_path / "proc")
    found = watcher.scan({"codex"})
    assert set(found) == {"codex"}
    info = found["codex"]
    assert info.pid == 4321
    assert info.cwd_basename == "myproj"


def test_scan_matches_interpreter_script(tmp_path):
    # pip console script: python3 /usr/local/bin/kimi ...
    make_proc(tmp_path, 5000, b"/usr/bin/python3\0/usr/local/bin/kimi\0chat\0")
    watcher = ProcessWatcher(tmp_path / "proc")
    found = watcher.scan({"kimi"})
    assert found["kimi"].pid == 5000
    # ...but a bare python process does not match "python3" unless asked.
    assert watcher.scan({"codex"}) == {}


def test_scan_process_exit_disappears(tmp_path):
    pid_dir = make_proc(tmp_path, 4321, b"/usr/bin/codex\0")
    watcher = ProcessWatcher(tmp_path / "proc")
    assert watcher.scan({"codex"}) != {}
    for child in pid_dir.iterdir():
        child.unlink()
    pid_dir.rmdir()
    assert watcher.scan({"codex"}) == {}


def test_scan_empty_names_and_missing_root(tmp_path):
    watcher = ProcessWatcher(tmp_path / "proc")
    assert watcher.scan(set()) == {}
    assert ProcessWatcher(tmp_path / "nonexistent").scan({"codex"}) == {}


# -- Store presence semantics (stub watcher) --------------------------------


class StubWatcher:
    def __init__(self, found=None):
        self.found = found or {}
        self.scanned_with = []

    def scan(self, names):
        self.scanned_with.append(set(names))
        return dict(self.found)


def make_config(**features):
    return Config(
        tools=[
            ToolConfig(id="codex", name="Codex", process="codex",
                       bindings={"ctrl-c": "C-c"}),
        ],
        features=FeaturesConfig(**features),
    )


def write_session(dir_path, session_id, *, tool="codex", **fields):
    data = {
        "id": session_id, "tool": tool, "session": f"name-{session_id}",
        "state": "running", "updated": int(time.time()),
    }
    data.update(fields)
    (dir_path / f"{session_id}.json").write_text(json.dumps(data))


def test_presence_makes_tool_selectable_but_idle(tmp_path):
    watcher = StubWatcher({"codex": ProcInfo(pid=4321, name="codex", cwd="/home/u/myproj")})
    store = SessionStore(tmp_path / "sessions", config=make_config(), watcher=watcher)
    store.poll()
    assert watcher.scanned_with == []  # not scanned until asked
    assert store.refresh_presence() is True
    assert watcher.scanned_with[-1] == {"codex"}

    tools = json.loads(store.tools_payload())
    assert tools["list"][0]["state"] == "ready"

    status = json.loads(store.status_payload())
    assert status["tool"] == "codex"
    assert status["state"] == "idle"
    assert status["session"] == "myproj"  # basename of /proc/PID/cwd
    assert status["ctx_pct"] == -1
    assert status["cost_usd"] == -1
    assert status["last"] == ""


def test_presence_reverts_to_idle_on_exit(tmp_path):
    watcher = StubWatcher({"codex": ProcInfo(pid=4321, name="codex", cwd="/x")})
    store = SessionStore(tmp_path / "sessions", config=make_config(), watcher=watcher)
    store.refresh_presence()
    assert json.loads(store.tools_payload())["list"][0]["state"] == "ready"

    watcher.found = {}
    assert store.refresh_presence() is True
    assert json.loads(store.tools_payload())["list"][0]["state"] == "idle"
    assert json.loads(store.status_payload())["state"] == "idle"
    assert store.refresh_presence() is False  # stable now


def test_adapter_data_wins_over_presence(tmp_path):
    watcher = StubWatcher({"codex": ProcInfo(pid=4321, name="codex", cwd="/x")})
    store = SessionStore(tmp_path / "sessions", config=make_config(), watcher=watcher)
    store.dir.mkdir()
    write_session(tmp_path / "sessions", "c1", state="waiting")
    store.poll()
    store.refresh_presence()

    assert store.presence("codex") is None  # suppressed while adapter data exists
    tools = json.loads(store.tools_payload())
    assert tools["list"][0]["state"] == "waiting"  # adapter state, not "running"
    status = json.loads(store.status_payload())
    assert status["session"] == "name-c1"  # real session, not the cwd basename


def test_presence_feature_toggle_off(tmp_path):
    watcher = StubWatcher({"codex": ProcInfo(pid=4321, name="codex", cwd="/x")})
    cfg = make_config(process_watcher=False)
    store = SessionStore(tmp_path / "sessions", config=cfg, watcher=watcher)
    assert store.refresh_presence() is False  # nothing found, nothing to clear
    assert watcher.scanned_with == []  # scan never ran
    assert json.loads(store.tools_payload())["list"][0]["state"] == "idle"

    # Toggling off clears previously-seen presence.
    cfg.features.process_watcher = True
    store.refresh_presence()
    assert json.loads(store.tools_payload())["list"][0]["state"] == "ready"
    cfg.features.process_watcher = False
    assert store.refresh_presence() is True  # cleared
    assert json.loads(store.tools_payload())["list"][0]["state"] == "idle"


# -- Hidden tools and voice toggle in payloads ------------------------------


def test_hidden_tools_omitted_from_tools_and_carousel(tmp_path):
    cfg = Config(tools=[
        ToolConfig(id="claude-code", name="Claude Code", hidden=True),
        ToolConfig(id="codex", name="Codex"),
        ToolConfig(id="kimi-cli", name="Kimi CLI"),
    ])
    store = SessionStore(tmp_path / "sessions", config=cfg)
    store.poll()
    assert store.selected_tool == "codex"  # hidden first tool skipped

    tools = json.loads(store.tools_payload())
    assert [t["id"] for t in tools["list"]] == ["codex", "kimi-cli"]

    # Carousel cycles only visible tools.
    assert store.apply_command({"cmd": "tool.next"}) is True
    assert store.selected_tool == "kimi-cli"
    store.apply_command({"cmd": "tool.next"})
    assert store.selected_tool == "codex"
    # Selecting a hidden tool is rejected.
    assert store.apply_command({"cmd": "tool.select", "id": "claude-code"}) is False
    assert store.selected_tool == "codex"


def test_voice_toggle_removes_voice_fn(tmp_path):
    cfg = Config(
        tools=[ToolConfig(id="codex", name="Codex", bindings={"ctrl-c": "C-c"})],
        features=FeaturesConfig(voice_enabled=False),
    )
    store = SessionStore(tmp_path / "sessions", config=cfg)
    tools = json.loads(store.tools_payload())
    assert tools["list"][0]["fns"] == ["status", "sessions", "ctrl-c"]

    cfg.features.voice_enabled = True
    store.set_config(cfg)
    tools = json.loads(store.tools_payload())
    assert tools["list"][0]["fns"] == ["status", "sessions", "voice", "ctrl-c"]


# -- Strict matching (bug 1: false positives) -------------------------------


def test_electron_desktop_app_is_not_the_cli(tmp_path):
    # codex-desktop electron app: real binary /opt/codex-desktop/codex.
    make_proc(
        tmp_path, 6001, b"/opt/codex-desktop/codex\0--no-sandbox\0",
        cwd_name="codex-desktop", exe="/opt/codex-desktop/codex",
    )
    watcher = ProcessWatcher(tmp_path / "proc")
    assert watcher.scan({"codex"}) == {}


def test_desktop_app_without_exe_symlink_still_excluded(tmp_path):
    # Unreadable /proc/PID/exe (perms): fall back to argv[0] dir check.
    make_proc(tmp_path, 6002, b"/opt/codex-desktop/codex\0")
    watcher = ProcessWatcher(tmp_path / "proc")
    assert watcher.scan({"codex"}) == {}


def test_update_manager_does_not_match_cli_name(tmp_path):
    make_proc(tmp_path, 6003, b"/usr/lib/codex/codex-update-manager\0",
              exe="/usr/lib/codex/codex-update-manager")
    watcher = ProcessWatcher(tmp_path / "proc")
    assert watcher.scan({"codex"}) == {}


def test_real_cli_binary_matches(tmp_path):
    make_proc(tmp_path, 6004, b"codex\0--json\0", cwd_name="myproj",
              exe="/home/u/.local/bin/codex")
    watcher = ProcessWatcher(tmp_path / "proc")
    found = watcher.scan({"codex"})
    assert found["codex"].pid == 6004
    assert found["codex"].session_label() == "myproj"


def test_shell_wrapper_is_not_matched(tmp_path):
    # "sh -c codex" is a shell, not the CLI; only python/node count as interpreters.
    make_proc(tmp_path, 6005, b"sh\0-c\0codex\0", exe="/bin/dash")
    watcher = ProcessWatcher(tmp_path / "proc")
    assert watcher.scan({"codex"}) == {}


def test_node_launched_cli_matches_via_argv1(tmp_path):
    make_proc(tmp_path, 6006, b"/usr/bin/node\0/usr/local/bin/kimi\0",
              exe="/usr/bin/node")
    watcher = ProcessWatcher(tmp_path / "proc")
    assert watcher.scan({"kimi"})["kimi"].pid == 6006


def test_generic_cwd_label_falls_back(tmp_path):
    # cwd basename equal to the process name is not informative.
    info = ProcInfo(pid=123, name="codex", cwd="/home/u/codex")
    assert info.session_label() == "codex (pid 123)"
    assert ProcInfo(pid=123, name="codex", cwd="").session_label() == "codex (pid 123)"
    assert ProcInfo(pid=123, name="codex", cwd="/opt/codex-desktop").session_label() == "codex (pid 123)"
    assert ProcInfo(pid=123, name="codex", cwd="/home/u/myproj").session_label() == "myproj"


# -- Per-tool presence isolation (bug 1 regression) -------------------------


def test_presence_is_strictly_per_tool(tmp_path):
    cfg = Config(tools=[
        ToolConfig(id="claude-code", name="Claude Code", process="claude"),
        ToolConfig(id="codex", name="Codex", process="codex"),
        ToolConfig(id="kimi-cli", name="Kimi CLI", process="kimi"),
    ])
    watcher = StubWatcher({"codex": ProcInfo(pid=4321, name="codex", cwd="/home/u/proj")})
    store = SessionStore(tmp_path / "sessions", config=cfg, watcher=watcher)
    store.poll()
    store.refresh_presence()

    for tid in ["claude-code", "codex", "kimi-cli"]:
        store.apply_command({"cmd": "tool.select", "id": tid})
        status = json.loads(store.status_payload())
        sessions = json.loads(store.sessions_payload())
        if tid == "codex":
            assert status["state"] == "idle"
            assert status["session"] == "proj"
            assert [e["id"] for e in sessions["list"]] == ["proc:4321"]
        else:
            # The other tools must NOT show codex's process.
            assert status["state"] == "idle", tid
            assert status["session"] == "", tid
            assert sessions["list"] == [], tid


# -- Synthesized presence sessions (bug 2) ----------------------------------


def test_presence_synthesizes_selectable_session(tmp_path):
    watcher = StubWatcher({"codex": ProcInfo(pid=4321, name="codex", cwd="/home/u/proj")})
    store = SessionStore(tmp_path / "sessions", config=make_config(), watcher=watcher)
    store.poll()
    store.refresh_presence()

    sessions = json.loads(store.sessions_payload())
    assert len(sessions["list"]) == 1
    entry = sessions["list"][0]
    assert entry == {"id": "proc:4321", "tool": "codex", "name": "proj", "state": "idle", "fg": True}
    assert sessions["active"] == 0
    assert store.active_id == "proc:4321"

    # Selectable/targetable like an adapter session.
    assert store.apply_command({"cmd": "session.select", "id": "proc:4321"}) is True
    assert store.active_id == "proc:4321"
    rec = store.active()
    assert rec is not None
    assert rec.raw.get("tmux") is None and rec.raw.get("tty") is None

    # STATUS comes from the synthesized record and is stable (no per-sync drift).
    s1 = store.status_payload()
    s2 = store.status_payload()
    assert s1 == s2
    status = json.loads(s1)
    assert status["state"] == "idle" and status["session"] == "proj"


def test_presence_links_same_directory_discovered_session(tmp_path):
    class Discovery:
        def scan(self, _tool_ids):
            return {"codex": [DiscoveredSession(
                id="live", tool="codex", name="Real session", updated=int(time.time()),
                last="Working now", tail=["user: hi", "assistant: Working now"],
                directory="/home/u/proj",
            )]}

    watcher = StubWatcher({"codex": ProcInfo(pid=4321, name="codex", cwd="/home/u/proj")})
    store = SessionStore(tmp_path / "sessions", config=make_config(), watcher=watcher,
                         discovery=Discovery())
    store.refresh_presence()
    store.refresh_discovery()
    status = json.loads(store.status_payload())
    assert status["session"] == "Real session"
    assert status["last"] == "Working now"
    assert status["tail"] == ["user: hi", "assistant: Working now"]


def test_synthesized_session_dropped_on_process_exit(tmp_path):
    watcher = StubWatcher({"codex": ProcInfo(pid=4321, name="codex", cwd="/x/proj")})
    store = SessionStore(tmp_path / "sessions", config=make_config(), watcher=watcher)
    store.refresh_presence()
    assert json.loads(store.sessions_payload())["list"] != []

    watcher.found = {}
    store.refresh_presence()
    assert json.loads(store.sessions_payload())["list"] == []
    assert json.loads(store.status_payload())["state"] == "idle"


def test_adapter_file_replaces_synthesized_session(tmp_path):
    watcher = StubWatcher({"codex": ProcInfo(pid=4321, name="codex", cwd="/x/proj")})
    store = SessionStore(tmp_path / "sessions", config=make_config(), watcher=watcher)
    store.dir.mkdir()
    store.refresh_presence()
    assert json.loads(store.sessions_payload())["list"][0]["id"] == "proc:4321"

    # Adapter file appears (still with the process running): adapter wins,
    # no duplicate synthesized entry.
    write_session(tmp_path / "sessions", "c1", state="running")
    store.poll()
    sessions = json.loads(store.sessions_payload())
    assert [e["id"] for e in sessions["list"]] == ["c1"]
    assert store.active_id == "c1"
