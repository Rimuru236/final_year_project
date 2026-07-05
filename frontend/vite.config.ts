import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev proxy: avoids CORS issues during local development.
    // In production set VITE_API_URL to your deployed backend URL.
    proxy: {
      "/auth": "http://localhost:8000",
      "/notes": "http://localhost:8000",
      "/predict": "http://localhost:8000",
      "/timetable": "http://localhost:8000",
      "/mcq": "http://localhost:8000",
      "/progress": "http://localhost:8000",
      "/health": "http://localhost:8000",
      "/onboarding": "http://localhost:8000",
      "/settings": "http://localhost:8000",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
