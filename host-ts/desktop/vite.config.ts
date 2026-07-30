import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri loads production assets from the installed application bundle. Relative
// URLs keep the renderer independent of a development-server origin.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    // Cargo's output can contain tens of thousands of files. It is not UI
    // source, and watching it exhausts Linux's inotify quota during tauri dev.
    watch: { ignored: ["**/src-tauri/target/**"] },
  },
});
