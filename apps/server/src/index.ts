import { createApp, startAction, type Broadcast } from "./app";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, repoRoot } from "./config";
import { Store } from "./db";
import { createNotifier, windowsToasts } from "./notifier";
import { buildProviders } from "./providers";
import { launch as realLaunch } from "./launcher";
import { claudeScanner, startTeamsSweep } from "./teamsSweep";
import { startWatcher } from "./watcher";

const cfg = loadConfig();
const store = new Store(cfg.server.database_path);
const providers = buildProviders(cfg);

// Windows toasts for sessions and watches that need you (see notifications: in config.yaml).
const notify = cfg.notifications.enabled && process.platform === "win32"
  ? createNotifier(cfg, windowsToasts(cfg.notifications.app_name, cfg.notifications.scenario),
    { sessions: store.listSessions(), watches: store.listWatches() })
  : null;

let server: ReturnType<typeof Bun.serve>;
const broadcast: Broadcast = (msg) => { server?.publish("stream", JSON.stringify(msg)); notify?.(msg); };

const watcher = startWatcher(store, providers, cfg.watch.poll_interval_seconds, (w) => broadcast({ type: "watch", data: w }));
const handle = createApp({ cfg, store, providers, broadcast, pollNow: () => void watcher.tick() });

const sweepEnabled = cfg.teams_sweep.enabled && cfg.teams_sweep.sources.length > 0;
if (sweepEnabled) {
  const sweepAction = cfg.actions.find((a) => a.key === cfg.teams_sweep.action)!;
  const actionDeps = {
    providers, store, broadcast,
    launch: (o: Parameters<typeof realLaunch>[2], cb: Parameters<typeof realLaunch>[3]) => realLaunch(cfg, store, o, cb),
  };
  const sweep = startTeamsSweep({
    cfg, store, providers, scanner: claudeScanner(cfg), log: (m) => console.warn(m),
    launchReview: async (url, vars) => {
      const r = await startAction(actionDeps, sweepAction, url, vars);
      if (!r.ok) throw new Error(r.error);
      if (r.kind !== "session") throw new Error("teams_sweep.action must start a session");
      return r.session_id;
    },
  });
  void sweep.tick();
}

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
console.log(`notifications: ${notify ? `Windows toasts (${cfg.notifications.scenario}, after ${cfg.notifications.delay_seconds}s)` : "off"}`);
console.log(`providers:${providers.map((p) => p.key).join(", ") || "none"} | database: ${cfg.server.database_path}`);
console.log(`teams sweep: ${sweepEnabled ? `every ${cfg.teams_sweep.interval_seconds}s, ${cfg.teams_sweep.sources.length} sources, action ${cfg.teams_sweep.action}` : "off"}`);
