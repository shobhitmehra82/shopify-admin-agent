import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The UI calls /api/* on its own origin; the chat backend runs separately.
    // Proxying keeps the browser same-origin, so no CORS in development.
    proxy: {
      "/api": {
        target: process.env.BACKEND_URL || "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
