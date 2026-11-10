import { createApp, type Broadcast } from "./app";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, repoRoot } from "./config";
import { Store } from "./db";
import { buildProviders } from "./providers";
import { startWatcher } from "./watcher";

const cfg = loadConfig();
const store = new Store(cfg.server.database_path);
const providers = buildProviders(cfg);

let server: ReturnType<typeof Bun.serve>;
const broadcast: Broadcast = (msg) => server?.publish("stream", JSON.stringify(msg));

const watcher = startWatcher(store, providers, cfg.watch.poll_interval_seconds, (w) => broadcast({ type: "watch", data: w }));
const handle = createApp({ cfg, store, providers, broadcast, pollNow: () => void watcher.tick() });

server = Bun.serve({
  hostname: cfg.server.host,
  port: cfg.server.port,
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/stream") {
      return srv.upgrade(req, { data: {} }) ? undefined : new Response("Expected a WebSocket", { status: 400 });
    }
    return handle(req);
  },
  websocket: {
    open(ws) { ws.subscribe("stream"); },
    message() {},
    close(ws) { ws.unsubscribe("stream"); },
  },
});

console.log(`claude-dashboard listening on http://${cfg.server.host}:${cfg.server.port}`);
console.log(`sessions start in: ${cfg.claude.default_cwd}`);
if (resolve(cfg.claude.default_cwd) === repoRoot) {
  console.warn("  note: that is the dashboard's own folder. Set claude.default_cwd in config.local.yaml (or CLAUDE_DASHBOARD_CWD) to your workspace so sessions pick up its Claude settings, permissions and tools.");
}
if (!existsSync(cfg.claude.default_cwd)) console.warn(`  warning: that folder does not exist on this machine.`);
console.log(`providers: ${providers.map((p) => p.key).join(", ") || "none"} | database: ${cfg.server.database_path}`);
