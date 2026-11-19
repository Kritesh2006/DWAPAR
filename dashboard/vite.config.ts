import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies the engine API so `npm run dev` works next to `python -m dwapar serve`.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/ws": { target: "ws://127.0.0.1:8000", ws: true },
    },
  },
});
