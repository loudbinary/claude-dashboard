import { existsSync, readFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import type { ActionConfig, Config } from "./config";
import { normalizeOrigins, repoRoot, WRITE_METHODS, type OriginRule } from "./config";
import type { PrSession, Session, Store, Watch } from "./db";
import { launch as realLaunch, stopSession as realStop, type LaunchOptions } from "./launcher";
import { resolveUrl } from "./providers";
import type { Provider } from "./providers/types";
import { normalizeHook } from "./state";
import { isClearCommand, readNotes, type Note } from "./transcript";

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

/** What starting an action needs; shared by the buttons (app) and the Teams sweep. */
export interface ActionDeps {
  providers: Provider[];
  store?: Store;
  broadcast: Broadcast;
  launch: (o: LaunchOptions, onChange: (s: Session) => void) => Promise<string>;
  pollNow?: () => void;
}

export type ActionResult =
  | { ok: true; kind: "session"; session_id: string }
  | { ok: true; kind: "watch"; watch: Watch }
  | { ok: false; status: number; error: string };

/**
 * Starts an action for a URL: a session (launch with the filled prompt) or a watch. `extraVars` fill extra
 * placeholders in the prompt and name (for example {source} and {sender} from the Teams sweep).
 */
export async function startAction(deps: ActionDeps, action: ActionConfig, url: string, extraVars: Record<string, string> = {}): Promise<ActionResult> {
  const { providers, broadcast } = deps;
  const hit = resolveUrl(providers, url);
  if (!hit) return { ok: false, status: 400, error: "That is not a recognized pull request, pipeline run or PagerDuty incident URL (or its provider is disabled in config)." };
  if (action.accepts && hit.ref.kind !== action.accepts) {
    return { ok: false, status: 400, error: `"${action.label}" expects a ${KIND_LABEL[action.accepts]} URL.` };
  }
  if (action.kind === "watch") {
    if (hit.ref.kind !== "run") return { ok: false, status: 400, error: `"${action.label}" can only watch pipeline runs.` };
    const w: Watch = deps.store!.addWatch(url, hit.provider.key, hit.ref.title);
    broadcast({ type: "watch", data: w });
    deps.pollNow?.();
    return { ok: true, kind: "watch", watch: w };
  }
  let details = "";
  if (action.prompt!.includes("{details}") && hit.provider.context) {
    try { details = await hit.provider.context(hit.ref); }
    catch (err) { return { ok: false, status: 502, error: `Could not read ${hit.ref.title}: ${(err as Error).message}` }; }
  }
  const vars = { ...extraVars, url, title: hit.ref.title, provider: hit.provider.key, details };
  try {
    const id = await deps.launch({
      prompt: fill(action.prompt!, vars),
      name: action.name ? fill(action.name, vars) : undefined,
      cwd: action.cwd, permission_mode: action.permission_mode, allowed_tools: action.allowed_tools,
      model: action.model || undefined,
    }, (s) => broadcast({ type: "session", data: s }));
    // Remember which PR this review is about, so its drafts can be posted back to it later.
    if (hit.ref.kind === "pr") deps.store?.linkSessionPr(id, url);
    return { ok: true, kind: "session", session_id: id };
  } catch (err) {
    return { ok: false, status: 502, error: (err as Error).message };
  }
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (status: number, error: string) => json({ error }, status);
const KIND_LABEL = { pr: "pull request", run: "pipeline run", incident: "PagerDuty incident" } as const;
const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);

/**
 * Requests from a web page on another site are refused, so a stray page cannot start sessions.
 * Loopback is always allowed; `server.allowed_origins` adds more (e.g. when bound to 0.0.0.0):
 * "host" matches any port, "host:port" that port, "http(s)://host:port" that exact origin. A rule with
 * `methods` only allows those write verbs from that origin.
 */
export function allowedOrigin(req: Request, extra: Parameters<typeof normalizeOrigins>[0] = []): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // Claude Code hooks, curl, same-origin GETs
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return true;
  const rule = listedOrigin(u, normalizeOrigins(extra));
  return !!rule && permits(rule, req.method);
}

/** The server.allowed_origins rule naming this origin, if any (loopback is not implied). */
function listedOrigin(u: URL, rules: readonly OriginRule[]): OriginRule | null {
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  return rules.find(({ match: e }) => e.includes("://") ? e === u.origin
    : e === u.hostname || e === `${u.hostname}:${port}`) ?? null;
}

/** Reads are always allowed; writes only if the rule grants that verb (no `methods` = all of them). */
const permits = (rule: OriginRule, method: string) =>
  ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) || !rule.methods || rule.methods.includes(method.toUpperCase());

async function body(req: Request): Promise<any | null> {
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return null;
  try { return await req.json(); } catch { return null; }
}

export function createApp(deps: AppDeps) {
  const { cfg, store, providers, broadcast } = deps;
  const launch = deps.launch ?? ((o, cb) => realLaunch(cfg, store, o, cb));
  const stop = deps.stop ?? realStop;
  const clientDir = deps.clientDir ?? resolve(repoRoot, "apps/client/dist");
  // Identifies the built client (hash of dist/index.html, which names the hashed assets), so open tabs can tell they are stale.
  const clientBuild = (): string | null => {
    try { return new Bun.CryptoHasher("sha1").update(readFileSync(join(clientDir, "index.html"))).digest("hex").slice(0, 12); } catch { return null; }
  };
  const onSession = (s: Session) => broadcast({ type: "session", data: s });

  const actionDeps: ActionDeps = { providers, store, broadcast, launch, pollNow: deps.pollNow };
  async function runAction(action: ActionConfig, url: string): Promise<Response> {
    const r = await startAction(actionDeps, action, url);
    if (!r.ok) return fail(r.status, r.error);
    return r.kind === "watch" ? json({ watch: r.watch }, 201) : json({ session_id: r.session_id }, 201);
  }

  /** Posts the approved drafts of a review session to its pull request. Never called by Claude, only by a click. */
  async function postDrafts(id: string, link: PrSession | null, b: any): Promise<Response> {
    if (!link?.pr_url) return fail(409, "This session is not linked to a pull request.");
    const items = b?.items;
    if (!Array.isArray(items) || !items.every((i: any) => Number.isInteger(i?.idx) && typeof i?.comment === "string" && i.comment.trim())) {
      return fail(400, "Expected JSON { items: [{ idx, comment }], include_summary?, summary? }");
    }
    if (new Set(items.map((i: any) => i.idx)).size !== items.length) return fail(400, "Duplicate idx in items");
    const wantSummary = b.include_summary === true;
    if (wantSummary && b.summary !== undefined && typeof b.summary !== "string") return fail(400, "summary must be a string");
    for (const i of items) {
      if (!store.getDraft(id, i.idx)) return fail(400, `No draft ${i.idx} for this session`);
    }
    const hit = resolveUrl(providers, link.pr_url);
    if (!hit || hit.ref.kind !== "pr" || !hit.provider.postThread || !hit.provider.prStatus) {
      return fail(409, "The provider for this pull request cannot post comments (or is disabled in config).");
    }
    const { provider, ref } = hit;
    // Closed pull requests get no new comments.
    try {
      const st = await provider.prStatus!(ref);
      if (st.status !== "active") return fail(409, `The pull request is ${st.status}, not active. Nothing was posted.`);
    } catch (err) {
      return fail(502, `Could not check the pull request: ${(err as Error).message}`);
    }

    const footer = cfg.pr_comments?.footer ?? "";
    const withFooter = (text: string) => text.trim() + (footer ? "\n\n" + footer : "");
    const posted: { idx: number; thread_id: string }[] = [];
    const failed: { idx: number; error: string }[] = [];
    const skipped: number[] = [];
    let summaryResult: { thread_id: string } | { error: string } | null = null;

    if (wantSummary && link.summary_thread_id) summaryResult = { thread_id: link.summary_thread_id };
    else if (wantSummary) {
      const text = (typeof b.summary === "string" ? b.summary : link.summary ?? "").trim();
      if (text) {
        try {
          const tid = await provider.postThread!(ref, { content: withFooter(text) });
          store.setSummaryPosted(id, text, tid);
          summaryResult = { thread_id: tid };
        } catch (err) { summaryResult = { error: (err as Error).message }; }
      }
    }

    for (const i of items as { idx: number; comment: string }[]) {
      const d = store.getDraft(id, i.idx)!;
      if (d.status === "posted") { skipped.push(i.idx); continue; }
      const text = i.comment.trim();
      try {
        const tid = await provider.postThread!(ref, { content: withFooter(text), filePath: d.file, line: d.line, endLine: d.end_line ?? undefined });
        store.markDraftPosted(id, i.idx, text, tid);
        posted.push({ idx: i.idx, thread_id: tid });
      } catch (err) {
        const error = (err as Error).message;
        store.markDraftFailed(id, i.idx, text, error);
        failed.push({ idx: i.idx, error });
      }
    }

    const summaryPosted = summaryResult && "thread_id" in summaryResult && !link.summary_thread_id;
    if (posted.length || failed.length || summaryResult) {
      store.addEvent(id, "PrCommentsPosted", {
        pr_url: link.pr_url,
        idx: posted.map((p) => p.idx),
        thread_ids: posted.map((p) => p.thread_id),
        ...(summaryPosted ? { summary_thread_id: (summaryResult as { thread_id: string }).thread_id } : {}),
        failures: [...failed, ...(summaryResult && "error" in summaryResult ? [{ idx: "summary", error: summaryResult.error }] : [])],
        ts: new Date().toISOString(),
      });
    }
    return json({ posted, failed, skipped, summary: summaryResult, drafts: store.listDrafts(id), summary_thread_id: store.getPrSession(id)?.summary_thread_id ?? null });
  }

  const extraOrigins = normalizeOrigins(cfg.server.allowed_origins);
  /**
   * CORS for the origins in server.allowed_origins (never for loopback, which is served same-origin):
   * answers preflights and adds Access-Control-Allow-Origin so a page on that origin can read the reply.
   * No credentials: the dashboard has no cookies or auth to share.
   */
  const corsRule = (req: Request): { origin: string; rule: OriginRule } | null => {
    const origin = req.headers.get("origin");
    if (!origin || !extraOrigins.length) return null;
    try { const rule = listedOrigin(new URL(origin), extraOrigins); return rule ? { origin, rule } : null; } catch { return null; }
  };
  return async function handle(req: Request): Promise<Response> {
    const hit = corsRule(req);
    const origin = hit?.origin ?? null;
    const preflight = req.headers.get("access-control-request-method");
    if (req.method === "OPTIONS" && preflight) {
      if (!hit || !permits(hit.rule, preflight)) return new Response(null, { status: 403, headers: { Vary: "Origin" } });
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": hit.origin,
        "Access-Control-Allow-Methods": ["GET", ...(hit.rule.methods ?? WRITE_METHODS), "OPTIONS"].join(", "),
        "Access-Control-Allow-Headers": req.headers.get("access-control-request-headers") ?? "content-type",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      } });
    }
    const res = await route(req);
    if (!origin) return res;
    const out = new Response(res.body, res); // copy: a response's headers can be immutable
    out.headers.set("Access-Control-Allow-Origin", origin);
    out.headers.append("Vary", "Origin");
    return out;
  };

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const m = req.method;
    if (m !== "GET" && !allowedOrigin(req, extraOrigins)) return fail(403, `Cross-origin ${m} refused`);

    // Hook ingest: raw Claude Code hook JSON (/hooks) or an event envelope (/events).
    if ((path === "/hooks" || path === "/events") && m === "POST") {
      const e = normalizeHook(await body(req));
      if (!e) return fail(400, "Expected hook JSON with hook_event_name and session_id");
      // Removed from the dashboard: stays removed, whatever the session does next.
      if (store.isRemoved(e.session_id)) return json({ ignored: true });
      // `/clear` is noise: don't record it as a prompt or let it name the session.
      if (e.hook_event_name === "UserPromptSubmit" && typeof e.prompt === "string" && isClearCommand(e.prompt)) return json({ ignored: true });
      onSession(store.applyHook(e));
      return json({});
    }

    if (path === "/api/config" && m === "GET") {
      return json({
        actions: cfg.actions.filter((a) => !a.hidden).map(({ key, label, kind, accepts }) => ({ key, label, kind, accepts })),
        status: cfg.ui.status,
        inactive_after_minutes: cfg.ui.inactive_after_minutes,
        seen_color: cfg.ui.seen_color ?? "#667085",
        providers: providers.map((p) => p.key),
        default_cwd: cfg.claude.default_cwd,
        client_build: clientBuild(),
      });
    }

    if (path === "/api/sweep" && m === "GET") {
      const ts = cfg.teams_sweep;
      const prs = store.listSweepPrs(undefined, 200);
      return json({
        enabled: ts.enabled,
        interval_seconds: ts.interval_seconds,
        sources: store.listSweepSources().map((s) => {
          const mine = prs.filter((p) => p.source === s.source_key);
          return {
            name: s.source_key, last_run_ts: s.last_run_ts, last_error: s.last_error,
            found: mine.length, launched: mine.filter((p) => p.decision === "launched").length,
          };
        }),
        recent: prs.slice(0, 30),
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

    const dm = path.match(/^\/api\/sessions\/([^/]+)\/drafts(\/post)?$/);
    if (dm) {
      const id = decodeURIComponent(dm[1]!);
      if (!store.getSession(id)) return fail(404, "Session not found");
      const link = store.getPrSession(id);
      if (!dm[2] && m === "GET") {
        return json({
          pr_url: link?.pr_url ?? null, verdict: link?.verdict ?? null, summary: link?.summary ?? null,
          summary_thread_id: link?.summary_thread_id ?? null, drafts: store.listDrafts(id),
        });
      }
      if (dm[2] && m === "POST") return postDrafts(id, link, await body(req));
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
            if (e.type === "UserPromptSubmit" && p.prompt && !isClearCommand(p.prompt)) return [{ role: "user", text: p.prompt, ts }];
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
  }
}
