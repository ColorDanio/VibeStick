import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri loads production assets from the installed application bundle. Relative
// URLs keep the renderer independent of a development-server origin.
export default defineConfig({ base: "./", plugins: [react()], server: { port: 5174, strictPort: true } });
