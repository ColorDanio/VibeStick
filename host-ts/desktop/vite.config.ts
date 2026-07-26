import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Electron loads the production renderer with file://. Relative asset URLs
// are required there; Vite's default /assets path resolves to file:///assets
// and leaves the desktop window as a blank background.
export default defineConfig({ base: "./", plugins: [react()], server: { port: 5174, strictPort: true } });
