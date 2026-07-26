use serde::Serialize;
use std::{
    env,
    fs,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

struct HostProcess(Mutex<Option<Child>>);

#[derive(Serialize)]
struct CommandResult {
    ok: bool,
    detail: String,
}

fn python_from_installed_vibeconn() -> Option<String> {
    for variable in ["VIBESTICK_LINUX_HELPER", "VIBECONN_PYTHON"] {
        if let Ok(value) = env::var(variable) {
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    let path = env::var_os("PATH")?;
    for directory in env::split_paths(&path) {
        for command in ["vibeconn", "vibeconnd"] {
            let launcher = directory.join(command);
            let Ok(content) = fs::read_to_string(&launcher) else { continue };
            let Some(first_line) = content.lines().next() else { continue };
            if let Some(interpreter) = first_line.strip_prefix("#!") {
                let binary = interpreter.trim().split_whitespace().next().unwrap_or_default();
                if binary.contains("python") && Path::new(binary).exists() {
                    return Some(binary.to_string());
                }
            }
        }
    }
    None
}

fn development_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn resource_path(app: &AppHandle, development_relative: &str, packaged_relative: &str) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(development_path(development_relative))
    } else {
        app.path().resource_dir().map_err(|error| error.to_string()).map(|path| path.join(packaged_relative))
    }
}

fn start_host(app: &AppHandle, state: &HostProcess) -> Result<(), String> {
    let mut current = state.0.lock().map_err(|_| "Host process state is unavailable")?;
    if current.as_ref().is_some_and(|child| child.id() > 0) {
        return Ok(());
    }
    let cli = resource_path(app, "../../dist/cli.js", "host-core/cli.js")?;
    if !cli.exists() {
        return Err(format!("HostCore executable is missing: {}", cli.display()));
    }
    let node = if cfg!(debug_assertions) {
        PathBuf::from(env::var("VIBECONN_NODE").unwrap_or_else(|_| "node".to_string()))
    } else {
        let runtime = if cfg!(target_os = "windows") { "runtime/vibeconn-node.exe" } else { "runtime/vibeconn-node" };
        resource_path(app, "", runtime)?
    };
    let mut command = Command::new(node);
    command.arg(cli).arg("--port").arg("7861");
    if cfg!(target_os = "linux") {
        let Some(python) = python_from_installed_vibeconn() else {
            return Err("Linux compatibility runtime not found. Install VibeConn 1.x or launch through tools/vibeconn.".to_string());
        };
        command.arg("--linux-helper").arg(python);
    } else {
        command.arg("--native-ble");
    }
    let compatibility = if cfg!(debug_assertions) {
        development_path("../../host/tools")
    } else {
        app.path().resource_dir().map_err(|error| error.to_string())?.join("host/tools")
    };
    command
        .env("VIBECONN_LINUX_HELPER_SCRIPT", compatibility.join("ble_gatt_helper.py"))
        .env("VIBECONN_LOCAL_ASR_HELPER", compatibility.join("asr_helper.py"))
        .env("VIBECONN_SESSION_DISCOVERY_HELPER", compatibility.join("session_discovery_helper.py"));
    let child = command.spawn().map_err(|error| format!("Could not start HostCore: {error}"))?;
    *current = Some(child);
    Ok(())
}

fn post_owner_release() -> Result<CommandResult, String> {
    let address = "127.0.0.1:7860".to_socket_addrs().map_err(|error| error.to_string())?.next().ok_or("Python 1.x endpoint is unavailable")?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(1500)).map_err(|error| error.to_string())?;
    stream.set_read_timeout(Some(Duration::from_millis(1500))).map_err(|error| error.to_string())?;
    stream.write_all(b"POST /api/command HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 23\r\nConnection: close\r\n\r\n{\"cmd\":\"owner.release\"}").map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream.read_to_string(&mut response).map_err(|error| error.to_string())?;
    if response.starts_with("HTTP/1.0 200") || response.starts_with("HTTP/1.1 200") {
        Ok(CommandResult { ok: true, detail: "Python 1.x released BLE. VibeConn 2.0 will retry shortly.".to_string() })
    } else {
        Err("Python 1.x refused owner release.".to_string())
    }
}

#[tauri::command]
fn release_python_owner() -> Result<CommandResult, String> {
    post_owner_release()
}

#[tauri::command]
fn restart_host(app: AppHandle, state: State<'_, HostProcess>) -> Result<CommandResult, String> {
    if let Some(mut child) = state.0.lock().map_err(|_| "Host process state is unavailable")?.take() {
        let _ = child.kill();
    }
    start_host(&app, &state)?;
    Ok(CommandResult { ok: true, detail: "VibeConn 2.0 restarted.".to_string() })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(HostProcess(Mutex::new(None)))
        .setup(|app| {
            start_host(&app.handle(), app.state::<HostProcess>()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![release_python_owner, restart_host])
        .run(tauri::generate_context!())
        .expect("error while running VibeConn");
}
