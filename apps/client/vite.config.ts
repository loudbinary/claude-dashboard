import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// In development the client runs on 5173 and proxies API and WebSocket calls to the server.
const target = process.env.DASHBOARD_SERVER ?? "http://127.0.0.1:4000";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": target,
      "/stream": { target, ws: true },
    },
  },
});
