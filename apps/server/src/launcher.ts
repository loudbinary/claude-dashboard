import type { Config } from "./config";
import type { Session, Store } from "./db";

export interface LaunchOptions {
  prompt: string;
  name?: string;
  cwd?: string;
  /** Session id, or a session title the Claude CLI can resolve. */
  resume?: string;
  /** Empty means: do not override; the workspace's Claude settings decide. */
  permission_mode?: string | null;
  allowed_tools?: string[] | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** CLI arguments for a headless Claude Code run that streams JSON lines. */
export function buildArgs(cfg: Config, o: LaunchOptions): string[] {
  const args = [cfg.claude.command, "-p", o.prompt, "--output-format", "stream-json", "--verbose"];
  if (o.resume) args.push("--resume", o.resume);
  else if (o.name) args.push("--name", o.name);
  if (o.permission_mode) args.push("--permission-mode", o.permission_mode);
  if (o.allowed_tools?.length) args.push("--allowedTools", o.allowed_tools.join(","));
  return [...args, ...(cfg.claude.extra_args ?? [])];
}

/**
 * Applies one line of `claude -p --output-format stream-json` output to the store.
 * Returned by makeStreamHandler so it can be tested without spawning the CLI.
 */
export function makeStreamHandler(store: Store, o: LaunchOptions, fallbackCwd: string, onChange: (s: Session) => void, onStarted: (id: string) => void) {
  const state = { sessionId: null as string | null, started: false, finished: false, title: null as string | null };
  const update = (patch: Partial<Session>) => { if (state.sessionId) onChange(store.upsertSession(state.sessionId, patch)); };

  function handle(line: string) {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "system" && msg.subtype === "session_title_changed" && typeof msg.title === "string") {
      state.title = msg.title;
    } else if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
      state.sessionId = msg.session_id;
      state.started = true;
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
      if (text) { store.addEvent(state.sessionId!, "AssistantMessage", { text }); update({ last_message: text }); }
    } else if (msg.type === "result") {
      state.finished = true;
      update({ state: msg.is_error ? "failed" : "waiting_reply", ...(typeof msg.result === "string" ? { last_message: msg.result } : {}) });
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

    const { handle, state, update } = makeStreamHandler(store, o, cfg.claude.default_cwd, onChange, resolveId);
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
      if (state.finished) return;
      const err = (await stderr).trim().slice(-600) || `claude exited with code ${code}`;
      if (state.started) update({ state: "failed", last_message: err });
      else reject(new Error(o.resume && !UUID.test(o.resume) ? `Could not resume "${o.resume}": ${err}` : err));
    })().catch(reject);
  });
}
