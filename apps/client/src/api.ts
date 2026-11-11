export interface StatusStyle { label: string; color: string; attention: boolean }
export interface Action { key: string; label: string; kind: "session" | "watch"; accepts?: "pr" | "run" | "incident" }
export interface AppConfig { actions: Action[]; status: Record<string, StatusStyle>; inactive_after_minutes: number; seen_color: string; providers: string[]; default_cwd: string }

export interface Session {
  id: string; name: string | null; default_name: string; cwd: string | null; state: string;
  last_prompt: string | null; last_message: string | null; source: "hook" | "dashboard";
  created_at: number; updated_at: number; seen: number;
}
export interface Watch { id: number; url: string; provider: string; title: string; state: string; detail: string | null; active: number; updated_at: number; seen: number }
export interface SweepInfo {
  enabled: boolean; interval_seconds: number;
  sources: { name: string; last_run_ts: number | null; last_error: string | null; found: number; launched: number }[];
  recent: { pr_key: string; url: string; source: string; decision: string; session_id: string | null; first_seen_ts: number }[];
}
export interface Note { role: "user" | "assistant"; text: string; ts: string | null }
export interface EventRow { id: number; type: string; payload: string; ts: number }
export interface SessionDetail { session: Session; events: EventRow[]; notes: Note[] }

/** Confirmation shared by every Remove button. */
export function confirmRemove(s: Session): boolean {
  const running = s.source === "dashboard"
    ? "Its Claude process is stopped if it is still running."
    : "It is a terminal session: it keeps running in its terminal, but will not show up here again.";
  return confirm(`Remove "${s.name ?? s.default_name}" from the dashboard?

${running} Later activity for it (hooks, cross-session messages) is ignored. The transcript on disk is untouched; Resume brings it back.`);
}

async function call<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: data === undefined ? undefined : { "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error ?? `Request failed (${res.status})`);
  return out as T;
}

export const api = {
  config: () => call<AppConfig>("/api/config"),
  sessions: () => call<Session[]>("/api/sessions"),
  newSession: (prompt: string, cwd: string, name: string) => call<{ session_id: string }>("/api/sessions", "POST", { prompt, cwd, name }),
  resumeSession: (session: string, prompt: string, cwd: string) => call<{ session_id: string }>("/api/sessions/resume", "POST", { session, prompt, cwd }),
  session: (id: string) => call<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  rename: (id: string, name: string) => call<Session>(`/api/sessions/${encodeURIComponent(id)}`, "PATCH", { name }),
  removeSession: (id: string) => call<{ stopped: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, "DELETE"),
  stopSession: (id: string) => call<{ stopped: boolean }>(`/api/sessions/${encodeURIComponent(id)}/stop`, "POST"),
  reply: (id: string, text: string) => call(`/api/sessions/${encodeURIComponent(id)}/reply`, "POST", { text }),
  runAction: (key: string, url: string) => call(`/api/actions/${key}`, "POST", { url }),
  sweep: () => call<SweepInfo>("/api/sweep"),
  watches: () => call<Watch[]>("/api/watches"),
  markSeen: (id: string) => call<Session>(`/api/sessions/${encodeURIComponent(id)}/seen`, "POST"),
  markWatchSeen: (id: number) => call<Watch>(`/api/watches/${id}/seen`, "POST"),
  removeWatch: (id: number) => call(`/api/watches/${id}`, "DELETE"),
};

/** Live updates. Reconnects on its own; `onOpen` lets the caller refetch after a gap. */
export function stream(onMessage: (m: { type: string; data: any }) => void, onOpen: () => void, onStatus: (up: boolean) => void) {
  let ws: WebSocket;
  const connect = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/stream`);
    ws.onopen = () => { onStatus(true); onOpen(); };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = () => { onStatus(false); setTimeout(connect, 2000); };
  };
  connect();
}

export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
