import { readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(await readFile(join(desktop, "src-tauri", "tauri.conf.json"), "utf8"));
const directory = join(desktop, "src-tauri", "target", "release", "bundle", "deb");
const source = join(directory, `${config.productName}_${config.version}_amd64.deb`);
const destination = join(directory, `VibeStick_${config.version}_amd64.deb`);

try {
  await stat(source);
  await rm(destination, { force: true });
  await rename(source, destination);
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  await stat(destination);
}
console.log(`Named Debian package: ${destination}`);
