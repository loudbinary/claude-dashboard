import type { Config } from "./config";
import type { Session, Store } from "./db";
import { extractDrafts } from "./drafts";

export interface LaunchOptions {
  prompt: string;
  name?: string;
  cwd?: string;
  /** Session id, or a session title the Claude CLI can resolve. */
  resume?: string;
  /** Empty means: do not override; the workspace's Claude settings decide. */
  permission_mode?: string | null;
  allowed_tools?: string[] | null;
  /** Model for this run (`--model`). Empty means: the CLI default. Wins over a --model in claude.extra_args. */
  model?: string | null;
}

/** Claude processes the dashboard started, by session id, while they run. */
const running = new Map<string, { proc: ReturnType<typeof Bun.spawn>; stopped: boolean }>();

export const isRunning = (id: string) => running.has(id);

/** Kills the process and everything it started (MCP servers, shells). */
export async function killTree(proc: ReturnType<typeof Bun.spawn>) {
  if (process.platform === "win32") {
    await Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited;
  }
  try { proc.kill(); } catch { /* already gone */ }
  await proc.exited;
}

/**
 * Stops the Claude process the dashboard is running for a session. Returns false when there is none
 * (finished already, or a terminal session the dashboard did not start).
 */
export async function stopSession(id: string): Promise<boolean> {
  const r = running.get(id);
  if (!r) return false;
  r.stopped = true;
  await killTree(r.proc); // the launch loop sees the exit and clears the entry
  return true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** CLI arguments for a headless Claude Code run that streams JSON lines. */
export function buildArgs(cfg: Config, o: LaunchOptions): string[] {
  const args = [cfg.claude.command, "-p", o.prompt, "--output-format", "stream-json", "--verbose"];
  if (o.resume) args.push("--resume", o.resume);
  else if (o.name) args.push("--name", o.name);
  if (o.permission_mode) args.push("--permission-mode", o.permission_mode);
  if (o.allowed_tools?.length) args.push("--allowedTools", o.allowed_tools.join(","));
  let extra = cfg.claude.extra_args ?? [];
  if (o.model) {
    args.push("--model", o.model);
    // The action's model wins: drop any --model from extra_args so the flag is never duplicated.
    const kept: string[] = [];
    for (let i = 0; i < extra.length; i++) {
      if (extra[i] === "--model") { i++; continue; }
      if (extra[i]!.startsWith("--model=")) continue;
      kept.push(extra[i]!);
    }
    extra = kept;
  }
  return [...args, ...extra];
}

/**
 * Applies one line of `claude -p --output-format stream-json` output to the store.
 * Returned by makeStreamHandler so it can be tested without spawning the CLI.
 */
export function makeStreamHandler(store: Store, o: LaunchOptions, fallbackCwd: string, onChange: (s: Session) => void, onStarted: (id: string) => void) {
  const state = { sessionId: null as string | null, started: false, finished: false, title: null as string | null };
  // A session removed from the dashboard stays removed: its remaining output is dropped.
  const live = () => !!state.sessionId && !store.isRemoved(state.sessionId);
  const update = (patch: Partial<Session>) => { if (live()) onChange(store.upsertSession(state.sessionId!, patch)); };

  function handle(line: string) {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "system" && msg.subtype === "session_title_changed" && typeof msg.title === "string") {
      state.title = msg.title;
    } else if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
      state.sessionId = msg.session_id;
      state.started = true;
      // Resuming a removed session on purpose brings it back.
      if (o.resume) store.unremove(msg.session_id);
      const known = store.getSession(msg.session_id);
      // A session the dashboard has not seen before takes the name given here, or its Claude title.
      const defaultName = !o.resume ? o.name : known ? undefined : state.title ?? undefined;
      update({ source: "dashboard", state: "working", last_prompt: o.prompt, cwd: msg.cwd ?? o.cwd ?? fallbackCwd,
               ...(defaultName ? { default_name: defaultName } : {}) });
      // Recorded here so the session is complete in the dashboard even when hooks are not installed.
      store.addEvent(msg.session_id, "UserPromptSubmit", { prompt: o.prompt, via: "dashboard" });
      onStarted(msg.session_id);
    } else if (!state.started) {
      // Anything before init (for example an error result for an unknown session) is not a session.
      return;
    } else if (msg.type === "assistant") {
      const text = (msg.message?.content ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n").trim();
      if (text && live()) { store.addEvent(state.sessionId!, "AssistantMessage", { text }); update({ last_message: text }); }
    } else if (msg.type === "result") {
      state.finished = true;
      update({ state: msg.is_error ? "failed" : "waiting_reply", ...(typeof msg.result === "string" ? { last_message: msg.result } : {}) });
      // A PR review ends with a `pr-comments` block: keep its drafts for the dashboard to post on request.
      // A missing or malformed block leaves any earlier drafts as they were.
      if (live() && !msg.is_error) {
        try {
          const drafts = extractDrafts(typeof msg.result === "string" ? msg.result : store.getSession(state.sessionId!)?.last_message);
          if (drafts) store.saveDrafts(state.sessionId!, drafts);
        } catch { /* drafts are optional; never break the stream */ }
      }
    }
  }
  return { handle, state, update };
}

/**
 * Starts (or resumes) a session and tracks it in the store.
 * Resolves with the session id once Claude reports it; the run continues in the background.
 */
export function launch(cfg: Config, store: Store, o: LaunchOptions, onChange: (s: Session) => void): Promise<string> {
  return new Promise((resolveId, reject) => {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(buildArgs(cfg, o), { cwd: o.cwd ?? cfg.claude.default_cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    } catch (err) {
      return reject(new Error(`Could not start "${cfg.claude.command}": ${(err as Error).message}`));
    }

    const { handle, state, update } = makeStreamHandler(store, o, cfg.claude.default_cwd, onChange, (id) => {
      running.set(id, { proc, stopped: false });
      resolveId(id);
    });
    const stderr = new Response(proc.stderr as ReadableStream).text();

    (async () => {
      let buf = "";
      const dec = new TextDecoder();
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      if (buf.trim()) handle(buf);
      const code = await proc.exited;
      const entry = state.sessionId ? running.get(state.sessionId) : undefined;
      if (entry?.proc === proc) running.delete(state.sessionId!);
      if (entry?.stopped) { update({ state: "done", last_message: "Stopped from the dashboard." }); return; }
      if (state.finished) return;
      const err = (await stderr).trim().slice(-600) || `claude exited with code ${code}`;
      if (state.started) update({ state: "failed", last_message: err });
      else reject(new Error(o.resume && !UUID.test(o.resume) ? `Could not resume "${o.resume}": ${err}` : err));
    })().catch(reject);
  });
}
