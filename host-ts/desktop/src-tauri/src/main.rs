use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::Mutex,
    time::Duration,
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WindowEvent,
};

struct HostProcess(Mutex<Option<Child>>);

const TRAY_ID: &str = "connection-status";

/// A small, high-contrast indicator that remains legible in Linux panels.
/// Green means the Host owns a ready Stick connection; amber is starting or
/// degraded; gray means the local Host is unavailable.
fn connection_icon(color: [u8; 4]) -> Image<'static> {
    const SIZE: u32 = 22;
    let mut rgba = vec![0; (SIZE * SIZE * 4) as usize];
    let center = (SIZE as i32 - 1) / 2;
    let radius = 8_i32;
    for y in 0..SIZE as i32 {
        for x in 0..SIZE as i32 {
            let dx = x - center;
            let dy = y - center;
            if dx * dx + dy * dy <= radius * radius {
                let index = ((y as u32 * SIZE + x as u32) * 4) as usize;
                rgba[index..index + 4].copy_from_slice(&color);
            }
        }
    }
    Image::new_owned(rgba, SIZE, SIZE)
}

fn dashboard_connection_state() -> (&'static str, [u8; 4]) {
    let address = match "127.0.0.1:7861"
        .to_socket_addrs()
        .ok()
        .and_then(|mut it| it.next())
    {
        Some(address) => address,
        None => return ("Vibe Stick: host unavailable", [120, 124, 130, 255]),
    };
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_millis(700)) {
        Ok(stream) => stream,
        Err(_) => return ("Vibe Stick: starting host", [230, 167, 40, 255]),
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    if stream
        .write_all(b"GET /api/diagnostics HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return ("Vibe Stick: starting host", [230, 167, 40, 255]);
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return ("Vibe Stick: starting host", [230, 167, 40, 255]);
    }
    if response.contains("\"host_2\": \"active\"") && response.contains("\"state\": \"ready\"") {
        ("Vibe Stick: Stick connected", [47, 179, 87, 255])
    } else if response.contains("\"state\": \"starting\"") {
        ("Vibe Stick: connecting to Stick…", [230, 167, 40, 255])
    } else {
        ("Vibe Stick: Stick disconnected", [216, 75, 75, 255])
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn start_connection_indicator(app: AppHandle, status: MenuItem<tauri::Wry>) {
    std::thread::spawn(move || loop {
        let (label, color) = dashboard_connection_state();
        let _ = status.set_text(label);
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            let _ = tray.set_icon(Some(connection_icon(color)));
        }
        std::thread::sleep(Duration::from_secs(2));
    });
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(
        app,
        "connection-state",
        "Vibe Stick: starting host",
        false,
        None::<&str>,
    )?;
    let open = MenuItem::with_id(app, "open", "Open Vibe Stick", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status, &open, &quit])?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(connection_icon([230, 167, 40, 255]))
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "quit" => {
                stop_own_host(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    start_connection_indicator(app.clone(), status);
    Ok(())
}

#[derive(Serialize)]
struct CommandResult {
    ok: bool,
    detail: String,
}

#[derive(Deserialize, Serialize)]
struct StartupResult {
    ok: bool,
    enabled: bool,
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
            let Ok(content) = fs::read_to_string(&launcher) else {
                continue;
            };
            let Some(first_line) = content.lines().next() else {
                continue;
            };
            if let Some(interpreter) = first_line.strip_prefix("#!") {
                let binary = interpreter
                    .trim()
                    .split_whitespace()
                    .next()
                    .unwrap_or_default();
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

fn resource_path(
    app: &AppHandle,
    development_relative: &str,
    packaged_relative: &str,
) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(development_path(development_relative))
    } else {
        app.path()
            .resource_dir()
            .map_err(|error| error.to_string())
            .map(|path| path.join(packaged_relative))
    }
}

fn node_runtime(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(
            env::var("VIBECONN_NODE").unwrap_or_else(|_| "node".to_string()),
        ))
    } else {
        let runtime = if cfg!(target_os = "windows") {
            "runtime/vibeconn-node.exe"
        } else {
            "runtime/vibeconn-node"
        };
        resource_path(app, "", runtime)
    }
}

/// A package update replaces files on disk but cannot replace a detached Node
/// child that was started by an older desktop instance. Before starting our
/// fixed loopback HostCore, terminate only prior Vibe Stick/VibeConn HostCore
/// commands (never arbitrary owners of port 7861) and give BlueZ/Node a brief
/// window to release the listener.
#[cfg(target_os = "linux")]
fn clear_stale_hostcores() {
    let stale = fs::read_dir("/proc")
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .filter_map(|entry| entry.file_name().to_string_lossy().parse::<u32>().ok())
        .filter(|pid| *pid != std::process::id())
        .filter(|pid| {
            let Ok(command) = fs::read(format!("/proc/{pid}/cmdline")) else {
                return false;
            };
            let args = command
                .split(|byte| *byte == 0)
                .filter_map(|part| std::str::from_utf8(part).ok())
                .collect::<Vec<_>>();
            args.iter().any(|arg| arg.ends_with("/host-core/cli.js"))
                && args.windows(2).any(|pair| pair == ["--port", "7861"])
        })
        .collect::<Vec<_>>();
    if stale.is_empty() {
        return;
    }
    let _ = Command::new("kill")
        .arg("-TERM")
        .args(stale.iter().map(u32::to_string))
        .status();
    for _ in 0..15 {
        let listening = TcpStream::connect_timeout(
            &"127.0.0.1:7861".parse().expect("fixed loopback address"),
            Duration::from_millis(50),
        )
        .is_ok();
        if !listening {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(not(target_os = "linux"))]
fn clear_stale_hostcores() {}

fn stop_own_host(app: &AppHandle) {
    if let Ok(mut current) = app.state::<HostProcess>().0.lock() {
        if let Some(mut child) = current.take() {
            let _ = child.kill();
        }
    }
}

fn start_host(app: &AppHandle, state: &HostProcess) -> Result<(), String> {
    let mut current = state
        .0
        .lock()
        .map_err(|_| "Host process state is unavailable")?;
    if current.as_ref().is_some_and(|child| child.id() > 0) {
        return Ok(());
    }
    let cli = resource_path(app, "../../dist/cli.js", "host-core/cli.js")?;
    if !cli.exists() {
        return Err(format!("HostCore executable is missing: {}", cli.display()));
    }
    clear_stale_hostcores();
    let node = node_runtime(app)?;
    let mut command = Command::new(node);
    command.arg(cli).arg("--port").arg("7861");
    if cfg!(target_os = "linux") {
        // BlueZ/D-Bus works without CAP_NET_RAW. Prefer an installed 1.x
        // interpreter for compatibility, otherwise use the system Python with
        // our packaged helper dependencies.
        let python = if cfg!(debug_assertions) {
            development_path("../../../host/.venv/bin/python")
                .to_string_lossy()
                .into_owned()
        } else {
            python_from_installed_vibeconn().unwrap_or_else(|| "python3".to_string())
        };
        command.arg("--linux-helper").arg(python);
    } else {
        command.arg("--native-ble");
    }
    let compatibility_root = if cfg!(debug_assertions) {
        development_path("../../../host")
    } else {
        app.path()
            .resource_dir()
            .map_err(|error| error.to_string())?
            .join("host")
    };
    let compatibility = if cfg!(debug_assertions) {
        compatibility_root.join("tools")
    } else {
        compatibility_root.join("tools")
    };
    let python_path = if cfg!(debug_assertions) {
        compatibility_root.to_string_lossy().into_owned()
    } else {
        compatibility
            .join("site-packages")
            .to_string_lossy()
            .into_owned()
    };
    command
        .env("PYTHONPATH", python_path)
        .env(
            "VIBECONN_LINUX_HELPER_SCRIPT",
            compatibility.join("ble_gatt_helper.py"),
        )
        .env(
            "VIBECONN_LOCAL_ASR_HELPER",
            compatibility.join("asr_helper.py"),
        )
        .env(
            "VIBECONN_SESSION_DISCOVERY_HELPER",
            compatibility.join("session_discovery_helper.py"),
        );
    let child = command
        .spawn()
        .map_err(|error| format!("Could not start HostCore: {error}"))?;
    *current = Some(child);
    Ok(())
}

fn post_owner_release() -> Result<CommandResult, String> {
    let address = "127.0.0.1:7860"
        .to_socket_addrs()
        .map_err(|error| error.to_string())?
        .next()
        .ok_or("Python 1.x endpoint is unavailable")?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(1500))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(1500)))
        .map_err(|error| error.to_string())?;
    stream.write_all(b"POST /api/command HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 23\r\nConnection: close\r\n\r\n{\"cmd\":\"owner.release\"}").map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    if response.starts_with("HTTP/1.0 200") || response.starts_with("HTTP/1.1 200") {
        Ok(CommandResult {
            ok: true,
            detail: "Python 1.x released BLE. Vibe Stick will retry shortly.".to_string(),
        })
    } else {
        Err("Python 1.x refused owner release.".to_string())
    }
}

#[tauri::command]
fn release_python_owner() -> Result<CommandResult, String> {
    post_owner_release()
}

#[tauri::command]
fn login_startup(app: AppHandle, action: String) -> Result<StartupResult, String> {
    if !["install", "uninstall", "status"].contains(&action.as_str()) {
        return Err("Unsupported startup action.".to_string());
    }
    let lifecycle = resource_path(
        &app,
        "../../dist/desktop-lifecycle-cli.js",
        "host-core/desktop-lifecycle-cli.js",
    )?;
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let output = Command::new(node_runtime(&app)?)
        .arg(lifecycle)
        .arg("--action")
        .arg(&action)
        .arg("--app")
        .arg(executable)
        .output()
        .map_err(|error| format!("Could not update startup registration: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed = serde_json::from_str::<StartupResult>(stdout.trim())
        .map_err(|error| format!("Startup registration returned invalid data: {error}"))?;
    if output.status.success() {
        Ok(parsed)
    } else {
        Err(parsed.detail)
    }
}

#[tauri::command]
fn restart_host(app: AppHandle, state: State<'_, HostProcess>) -> Result<CommandResult, String> {
    if let Some(mut child) = state
        .0
        .lock()
        .map_err(|_| "Host process state is unavailable")?
        .take()
    {
        let _ = child.kill();
    }
    start_host(&app, &state)?;
    Ok(CommandResult {
        ok: true,
        detail: "Vibe Stick restarted.".to_string(),
    })
}

/// A package upgrade can replace an older HostCore while its loopback listener
/// is still closing. The first child then exits with EADDRINUSE just after
/// `spawn` succeeds. Retry only if that child has actually exited; a healthy
/// HostCore is never restarted.
fn retry_failed_host_start(app: AppHandle) {
    std::thread::spawn(move || {
        for _ in 0..3 {
            std::thread::sleep(Duration::from_secs(1));
            let state = app.state::<HostProcess>();
            let needs_restart = {
                let Ok(mut current) = state.0.lock() else {
                    return;
                };
                match current.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(_)) | Err(_) => {
                            *current = None;
                            true
                        }
                        Ok(None) => false,
                    },
                    None => true,
                }
            };
            if !needs_restart {
                return;
            }
            let _ = start_host(&app, &state);
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(HostProcess(Mutex::new(None)))
        .setup(|app| {
            start_host(&app.handle(), &app.state::<HostProcess>())
                .map_err(std::io::Error::other)?;
            retry_failed_host_start(app.handle().clone());
            setup_tray(&app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .on_page_load(|webview, _| {
            let _ = webview.window().set_title("Vibe Stick");
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            release_python_owner,
            restart_host,
            login_startup
        ])
        .run(tauri::generate_context!())
        .expect("error while running Vibe Stick");
}
