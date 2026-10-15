import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The fixtures live at the branch root, two levels up; let Vite serve them in place.
export default defineConfig({
  plugins: [react()],
  server: { port: 5199, fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
});
