import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = dirname(dirname(new URL(import.meta.url).pathname));
const destination = join(root, "src-tauri", "resources", process.platform === "win32" ? "vibeconn-node.exe" : "vibeconn-node");
const hostCore = join(root, "..", "dist", "cli.js");

await stat(hostCore);
await mkdir(dirname(destination), { recursive: true });
await copyFile(process.execPath, destination);
if (process.platform !== "win32") await chmod(destination, 0o755);
console.log(`Staged Node ${process.version}: ${destination}`);
