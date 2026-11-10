import type { Config } from "./config";
import type { Session, Store } from "./db";

export interface LaunchOptions {
  prompt: string;
  name?: string;
  cwd?: string;
  resume?: string;
  permission_mode?: string;
  allowed_tools?: string[];
}

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

    let sessionId: string | null = o.resume ?? null;
    let finished = false;
    const update = (patch: Partial<Session>) => { if (sessionId) onChange(store.upsertSession(sessionId, patch)); };

    const handle = (line: string) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
        sessionId = msg.session_id;
        update({ source: "dashboard", state: "working", last_prompt: o.prompt, cwd: msg.cwd ?? o.cwd ?? cfg.claude.default_cwd,
                 ...(o.name && !o.resume ? { default_name: o.name } : {}) });
        // Recorded here so the session is complete in the dashboard even when hooks are not installed.
        store.addEvent(sessionId!, "UserPromptSubmit", { prompt: o.prompt, via: "dashboard" });
        resolveId(sessionId!);
      } else if (msg.type === "assistant" && sessionId) {
        const text = (msg.message?.content ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n").trim();
        if (text) { store.addEvent(sessionId, "AssistantMessage", { text }); update({ last_message: text }); }
      } else if (msg.type === "result") {
        finished = true;
        if (msg.session_id) sessionId = msg.session_id;
        update({ state: msg.is_error ? "failed" : "waiting_reply", last_message: typeof msg.result === "string" ? msg.result : null });
      }
    };

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
      if (!finished) {
        const err = (await new Response(proc.stderr as ReadableStream).text()).trim().slice(-500);
        if (sessionId) update({ state: "failed", last_message: err || `claude exited with code ${code}` });
        else reject(new Error(err || `claude exited with code ${code} before starting a session`));
      }
    })().catch(reject);
  });
}
