import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import type { ActionConfig, Config } from "./config";
import { repoRoot } from "./config";
import type { Session, Store, Watch } from "./db";
import { launch as realLaunch, type LaunchOptions } from "./launcher";
import { resolveUrl } from "./providers";
import type { Provider } from "./providers/types";
import { normalizeHook } from "./state";
import { readNotes } from "./transcript";

export type Broadcast = (msg: { type: "session" | "session_deleted" | "watch" | "watch_deleted"; data: unknown }) => void;

export interface AppDeps {
  cfg: Config;
  store: Store;
  providers: Provider[];
  broadcast: Broadcast;
  /** Runs one poll right away (used after adding a watch). */
  pollNow?: () => void;
  launch?: (o: LaunchOptions, onChange: (s: Session) => void) => Promise<string>;
  clientDir?: string;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (status: number, error: string) => json({ error }, status);
const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);

/** Requests from a web page on another site are refused, so a stray page cannot start sessions. */
function allowedOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // Claude Code hooks, curl, same-origin GETs
  try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname); } catch { return false; }
}

async function body(req: Request): Promise<any | null> {
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return null;
  try { return await req.json(); } catch { return null; }
}

export function createApp(deps: AppDeps) {
  const { cfg, store, providers, broadcast } = deps;
  const launch = deps.launch ?? ((o, cb) => realLaunch(cfg, store, o, cb));
  const clientDir = deps.clientDir ?? resolve(repoRoot, "apps/client/dist");
  const onSession = (s: Session) => broadcast({ type: "session", data: s });

  async function runAction(action: ActionConfig, url: string): Promise<Response> {
    const hit = resolveUrl(providers, url);
    if (!hit) return fail(400, "That is not a recognized Azure DevOps or GitHub pull request or pipeline URL (or its provider is disabled in config).");
    if (action.accepts && hit.ref.kind !== action.accepts) {
      return fail(400, `"${action.label}" expects a ${action.accepts === "pr" ? "pull request" : "pipeline run"} URL.`);
    }
    if (action.kind === "watch") {
      const w: Watch = store.addWatch(url, hit.provider.key, hit.ref.title);
      broadcast({ type: "watch", data: w });
      deps.pollNow?.();
      return json({ watch: w }, 201);
    }
    const vars = { url, title: hit.ref.title, provider: hit.provider.key };
    try {
      const id = await launch({
        prompt: fill(action.prompt!, vars),
        name: action.name ? fill(action.name, vars) : undefined,
        cwd: action.cwd, permission_mode: action.permission_mode, allowed_tools: action.allowed_tools,
      }, onSession);
      return json({ session_id: id }, 201);
    } catch (err) {
      return fail(502, (err as Error).message);
    }
  }

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const m = req.method;
    if (m !== "GET" && !allowedOrigin(req)) return fail(403, "Cross-origin request refused");

    // Hook ingest: raw Claude Code hook JSON (/hooks) or an event envelope (/events).
    if ((path === "/hooks" || path === "/events") && m === "POST") {
      const e = normalizeHook(await body(req));
      if (!e) return fail(400, "Expected hook JSON with hook_event_name and session_id");
      onSession(store.applyHook(e));
      return json({});
    }

    if (path === "/api/config" && m === "GET") {
      return json({
        actions: cfg.actions.map(({ key, label, kind, accepts }) => ({ key, label, kind, accepts })),
        status: cfg.ui.status,
        inactive_after_minutes: cfg.ui.inactive_after_minutes,
        providers: providers.map((p) => p.key),
      });
    }

    if (path === "/api/sessions" && m === "GET") return json(store.listSessions());

    const sm = path.match(/^\/api\/sessions\/([^/]+)(\/reply)?$/);
    if (sm) {
      const id = decodeURIComponent(sm[1]!);
      const s = store.getSession(id);
      if (!s) return fail(404, "Session not found");
      if (!sm[2] && m === "GET") {
        return json({ session: s, events: store.sessionEvents(id), notes: readNotes(s.transcript_path) });
      }
      if (!sm[2] && m === "PATCH") {
        const b = await body(req);
        if (!b || !("name" in b)) return fail(400, "Expected JSON { name }");
        const next = store.renameSession(id, b.name)!;
        onSession(next);
        return json(next);
      }
      if (!sm[2] && m === "DELETE") {
        store.deleteSession(id);
        broadcast({ type: "session_deleted", data: { id } });
        return json({});
      }
      if (sm[2] && m === "POST") {
        const b = await body(req);
        if (!b?.text?.trim()) return fail(400, "Expected JSON { text }");
        if (s.source !== "dashboard") return fail(409, "Only sessions started from the dashboard can be answered here. Reply in the terminal for this one.");
        try {
          await launch({ prompt: b.text, resume: id, cwd: s.cwd ?? undefined }, onSession);
          return json({ session_id: id });
        } catch (err) {
          return fail(502, (err as Error).message);
        }
      }
    }

    const am = path.match(/^\/api\/actions\/([^/]+)$/);
    if (am && m === "POST") {
      const action = cfg.actions.find((a) => a.key === am[1]);
      if (!action) return fail(404, "Unknown action");
      const b = await body(req);
      if (!b?.url?.trim()) return fail(400, "Expected JSON { url }");
      return runAction(action, b.url.trim());
    }

    if (path === "/api/watches" && m === "GET") return json(store.listWatches());
    const wm = path.match(/^\/api\/watches\/(\d+)$/);
    if (wm && m === "DELETE") {
      store.deleteWatch(Number(wm[1]));
      broadcast({ type: "watch_deleted", data: { id: Number(wm[1]) } });
      return json({});
    }

    // Built client (after `bun run build`). In development the Vite server proxies to this one.
    if (m === "GET" && existsSync(clientDir)) {
      const rel = normalize(path === "/" ? "index.html" : path.slice(1));
      if (!rel.startsWith("..")) {
        const f = Bun.file(join(clientDir, rel));
        if (await f.exists()) return new Response(f);
        if (!path.startsWith("/api")) return new Response(Bun.file(join(clientDir, "index.html")));
      }
    }
    return fail(404, "Not found");
  };
}
