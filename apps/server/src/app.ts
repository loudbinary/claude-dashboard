import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import type { ActionConfig, Config } from "./config";
import { repoRoot } from "./config";
import type { Session, Store, Watch } from "./db";
import { launch as realLaunch, stopSession as realStop, type LaunchOptions } from "./launcher";
import { resolveUrl } from "./providers";
import type { Provider } from "./providers/types";
import { normalizeHook } from "./state";
import { readNotes, type Note } from "./transcript";

export type Broadcast = (msg: { type: "session" | "session_deleted" | "watch" | "watch_deleted"; data: unknown }) => void;

export interface AppDeps {
  cfg: Config;
  store: Store;
  providers: Provider[];
  broadcast: Broadcast;
  /** Runs one poll right away (used after adding a watch). */
  pollNow?: () => void;
  launch?: (o: LaunchOptions, onChange: (s: Session) => void) => Promise<string>;
  /** Kills the Claude process the dashboard runs for a session; false when there is none. */
  stop?: (id: string) => Promise<boolean>;
  clientDir?: string;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (status: number, error: string) => json({ error }, status);
const KIND_LABEL = { pr: "pull request", run: "pipeline run", incident: "PagerDuty incident" } as const;
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
  const stop = deps.stop ?? realStop;
  const clientDir = deps.clientDir ?? resolve(repoRoot, "apps/client/dist");
  const onSession = (s: Session) => broadcast({ type: "session", data: s });

  async function runAction(action: ActionConfig, url: string): Promise<Response> {
    const hit = resolveUrl(providers, url);
    if (!hit) return fail(400, "That is not a recognized pull request, pipeline run or PagerDuty incident URL (or its provider is disabled in config).");
    if (action.accepts && hit.ref.kind !== action.accepts) {
      return fail(400, `"${action.label}" expects a ${KIND_LABEL[action.accepts]} URL.`);
    }
    if (action.kind === "watch") {
      if (hit.ref.kind !== "run") return fail(400, `"${action.label}" can only watch pipeline runs.`);
      const w: Watch = store.addWatch(url, hit.provider.key, hit.ref.title);
      broadcast({ type: "watch", data: w });
      deps.pollNow?.();
      return json({ watch: w }, 201);
    }
    let details = "";
    if (action.prompt!.includes("{details}") && hit.provider.context) {
      try { details = await hit.provider.context(hit.ref); }
      catch (err) { return fail(502, `Could not read ${hit.ref.title}: ${(err as Error).message}`); }
    }
    const vars = { url, title: hit.ref.title, provider: hit.provider.key, details };
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
      // Removed from the dashboard: stays removed, whatever the session does next.
      if (store.isRemoved(e.session_id)) return json({ ignored: true });
      onSession(store.applyHook(e));
      return json({});
    }

    if (path === "/api/config" && m === "GET") {
      return json({
        actions: cfg.actions.map(({ key, label, kind, accepts }) => ({ key, label, kind, accepts })),
        status: cfg.ui.status,
        inactive_after_minutes: cfg.ui.inactive_after_minutes,
        seen_color: cfg.ui.seen_color ?? "#667085",
        providers: providers.map((p) => p.key),
        default_cwd: cfg.claude.default_cwd,
      });
    }

    if (path === "/api/sessions" && m === "GET") return json(store.listSessions());

    // Start a new Claude CLI session from the dashboard, so it can be followed and answered here.
    if (path === "/api/sessions" && m === "POST") {
      const b = await body(req);
      if (!b?.prompt?.trim()) return fail(400, "Expected JSON { prompt, cwd?, name? }");
      const cwd = b.cwd?.trim() || cfg.claude.default_cwd;
      if (!existsSync(cwd)) return fail(400, `Working folder does not exist: ${cwd}`);
      try {
        const id = await launch({
          prompt: b.prompt, cwd, name: b.name?.trim() || undefined,
          permission_mode: cfg.claude.new_session?.permission_mode,
          allowed_tools: cfg.claude.new_session?.allowed_tools,
        }, onSession);
        return json({ session_id: id }, 201);
      } catch (err) {
        return fail(502, (err as Error).message);
      }
    }

    // Resume a session by name or id. Sessions the dashboard knows are matched first (by id, then by
    // name); anything else is handed to the Claude CLI, which resolves ids and its own session titles.
    if (path === "/api/sessions/resume" && m === "POST") {
      const b = await body(req);
      const wanted = b?.session?.trim();
      if (!wanted) return fail(400, "Expected JSON { session, prompt?, cwd? }");
      const all = store.listSessions(); // most recently updated first
      const lower = wanted.toLowerCase();
      const known = all.find((s) => s.id === wanted)
        ?? all.find((s) => (s.name ?? s.default_name).toLowerCase() === lower)
        ?? all.find((s) => s.default_name.toLowerCase() === lower);
      const cwd = b.cwd?.trim() || known?.cwd || cfg.claude.default_cwd;
      if (!existsSync(cwd)) return fail(400, `Working folder does not exist: ${cwd}`);
      try {
        const id = await launch({
          prompt: b.prompt?.trim() || "Continue where you left off.",
          resume: known?.id ?? wanted, cwd,
          permission_mode: cfg.claude.new_session?.permission_mode,
          allowed_tools: cfg.claude.new_session?.allowed_tools,
        }, onSession);
        return json({ session_id: id }, 201);
      } catch (err) {
        return fail(502, (err as Error).message);
      }
    }

    const sm = path.match(/^\/api\/sessions\/([^/]+)(\/reply|\/seen|\/stop)?$/);
    if (sm) {
      const id = decodeURIComponent(sm[1]!);
      const s = store.getSession(id);
      if (!s) return fail(404, "Session not found");
      if (sm[2] === "/stop" && m === "POST") {
        if (!(await stop(id))) return fail(409, "No running process for this session. Only sessions started from the dashboard can be stopped here.");
        return json({ stopped: true });
      }
      if (sm[2] === "/seen" && m === "POST") {
        const next = store.markSeen(id)!;
        onSession(next);
        return json(next);
      }
      if (!sm[2] && m === "GET") {
        const events = store.sessionEvents(id);
        let notes: Note[] = readNotes(s.transcript_path);
        // No transcript file known (hooks not installed): rebuild the notes from what the dashboard recorded.
        if (!notes.length) {
          notes = events.flatMap((e): Note[] => {
            const p = JSON.parse(e.payload);
            const ts = new Date(e.ts).toISOString();
            if (e.type === "UserPromptSubmit" && p.prompt) return [{ role: "user", text: p.prompt, ts }];
            if (e.type === "AssistantMessage" && p.text) return [{ role: "assistant", text: p.text, ts }];
            return [];
          });
        }
        return json({ session: s, events, notes });
      }
      if (!sm[2] && m === "PATCH") {
        const b = await body(req);
        if (!b || !("name" in b)) return fail(400, "Expected JSON { name }");
        const next = store.renameSession(id, b.name)!;
        onSession(next);
        return json(next);
      }
      if (!sm[2] && m === "DELETE") {
        // Remove (and remember the removal) first, so nothing the process does while it shuts down can
        // write the session back; then stop the process if the dashboard is running one.
        store.deleteSession(id);
        const stopped = await stop(id);
        broadcast({ type: "session_deleted", data: { id } });
        return json({ stopped });
      }
      if (sm[2] === "/reply" && m === "POST") {
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
    const wm = path.match(/^\/api\/watches\/(\d+)(\/seen)?$/);
    if (wm && wm[2] && m === "POST") {
      const w = store.markWatchSeen(Number(wm[1]));
      if (!w) return fail(404, "Watch not found");
      broadcast({ type: "watch", data: w });
      return json(w);
    }
    if (wm && !wm[2] && m === "DELETE") {
      store.deleteWatch(Number(wm[1]));
      broadcast({ type: "watch_deleted", data: { id: Number(wm[1]) } });
      return json({});
    }

    // Built client (after `bun run build`). In development the Vite server proxies to this one.
    if (m === "GET" && existsSync(clientDir)) {
      const rel = normalize(path === "/" ? "index.html" : path.slice(1));
      if (!rel.startsWith("..")) {
        // index.html names the current build's hashed assets, so the browser must revalidate it on every
        // load; otherwise a cached copy keeps running an older client after a rebuild.
        const page = () => new Response(Bun.file(join(clientDir, "index.html")), { headers: { "Cache-Control": "no-cache" } });
        if (rel === "index.html") return page();
        const f = Bun.file(join(clientDir, rel));
        if (await f.exists()) return new Response(f);
        if (!path.startsWith("/api")) return page();
      }
    }
    return fail(404, "Not found");
  };
}
