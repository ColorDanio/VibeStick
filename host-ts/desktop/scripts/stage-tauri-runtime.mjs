import { chmod, copyFile, cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(root, "src-tauri", "resources", process.platform === "win32" ? "vibeconn-node.exe" : "vibeconn-node");
const hostCore = join(root, "..", "dist", "cli.js");
const sourceModules = join(root, "..", "node_modules");
const coreRuntime = join(root, "src-tauri", "host-core-runtime");
const runtimeModules = join(coreRuntime, "node_modules");
const legacyRuntimeModules = join(root, "src-tauri", "resources", "host-core-node_modules");
const helperRuntime = join(root, "src-tauri", "host-tools");
const staleAppImageDirectory = join(root, "src-tauri", "target", "release", "bundle", "appimage", "VibeConn.AppDir");

await stat(hostCore);
await mkdir(dirname(destination), { recursive: true });
await copyFile(process.execPath, destination);
if (process.platform !== "win32") await chmod(destination, 0o755);
console.log(`Staged Node ${process.version}: ${destination}`);

// Do not bundle the development workspace's complete node_modules tree. Apart
// from being unnecessarily large, optional USB prebuilds for other libc/CPU
// targets make linuxdeploy fail while constructing an AppImage. HostCore only
// needs Noble and its Linux HCI implementation; copy their runtime dependency
// closure, deliberately excluding optional dependencies such as usb.
const copied = new Set();
async function stagePackage(name) {
  if (copied.has(name)) return;
  copied.add(name);
  const source = join(sourceModules, ...name.split("/"));
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  const target = join(runtimeModules, ...name.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, dereference: true });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) await stagePackage(dependency);
}

await rm(runtimeModules, { recursive: true, force: true });
await rm(coreRuntime, { recursive: true, force: true });
await rm(helperRuntime, { recursive: true, force: true });
await rm(legacyRuntimeModules, { recursive: true, force: true });
// linuxdeploy reuses an existing AppDir. Remove only this generated staging
// directory so a changed resource set cannot leave stale development modules
// in a later AppImage build.
await rm(staleAppImageDirectory, { recursive: true, force: true });
await cp(join(root, "..", "dist"), coreRuntime, { recursive: true, dereference: true });
await mkdir(runtimeModules, { recursive: true });
await stagePackage("@abandonware/noble");
// Noble marks the Linux HCI backend optional so macOS/Windows installs work,
// but it is a supported Linux native-BLE path and must ship in the desktop app.
await stagePackage("@abandonware/bluetooth-hci-socket");
await mkdir(helperRuntime, { recursive: true });
for (const helper of ["ble_gatt_helper.py", "asr_helper.py", "session_discovery_helper.py"])
  await copyFile(join(root, "..", "..", "host", "tools", helper), join(helperRuntime, helper));
// Linux packages use the stable BlueZ/D-Bus helper instead of requiring
// CAP_NET_RAW on the user's Node executable. Ship the small Python runtime
// closure it needs, while leaving the OS Python interpreter unmodified.
await cp(join(root, "..", "..", "host", "vibestick"), join(helperRuntime, "vibestick"), { recursive: true, dereference: true });
const pythonLibraries = join(root, "..", "..", "host", ".venv", "lib", "python3.14", "site-packages");
const helperSitePackages = join(helperRuntime, "site-packages");
await mkdir(helperSitePackages, { recursive: true });
for (const name of await readdir(pythonLibraries)) {
  if (/^(bleak|dbus_fast|typing_extensions)(-|\.|$)/.test(name))
    await cp(join(pythonLibraries, name), join(helperSitePackages, name), { recursive: true, dereference: true });
}
console.log(`Staged ${copied.size} HostCore runtime packages: ${runtimeModules}`);
