import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Linux needs Noble's HCI addon; macOS/Windows use Noble's own platform binding.
// Rebuilding only the active binding avoids the unused optional `usb` module.
const target = process.platform === "linux" ? "@abandonware/bluetooth-hci-socket" : "@abandonware/noble";
const executable = join(root, "node_modules", ".bin", process.platform === "win32" ? "electron-rebuild.cmd" : "electron-rebuild");
const child = spawn(executable, ["--force", "--which-module", target], { stdio: "inherit", shell: process.platform === "win32" });
child.once("error", (error) => { console.error(`Could not rebuild ${target}: ${error.message}`); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
