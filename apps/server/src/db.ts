import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { HookInput, SessionState } from "./state";
import { nextState } from "./state";

export interface Session {
  id: string;
  name: string | null;          // set by the user; null means "use default_name"
  default_name: string;
  cwd: string | null;
  transcript_path: string | null;
  state: SessionState;
  last_prompt: string | null;
  last_message: string | null;
  source: "hook" | "dashboard";
  created_at: number;
  updated_at: number;
}

export interface Watch {
  id: number;
  url: string;
  provider: string;
  title: string;
  state: string;
  detail: string | null;
  active: number;
  created_at: number;
  updated_at: number;
}

export interface EventRow { id: number; session_id: string; type: string; payload: string; ts: number }

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export class Store {
  db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, name TEXT, default_name TEXT NOT NULL, cwd TEXT, transcript_path TEXT,
        state TEXT NOT NULL, last_prompt TEXT, last_message TEXT, source TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, type TEXT NOT NULL,
        payload TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);
      CREATE TABLE IF NOT EXISTS watches (
        id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, provider TEXT NOT NULL, title TEXT NOT NULL,
        state TEXT NOT NULL, detail TEXT, active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    `);
  }

  getSession(id: string): Session | null {
    return this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as Session | null;
  }

  listSessions(): Session[] {
    return this.db.query("SELECT * FROM sessions ORDER BY updated_at DESC").all() as Session[];
  }

  /** Create or patch a session row. */
  upsertSession(id: string, patch: Partial<Session>, now = Date.now()): Session {
    const cur = this.getSession(id);
    const s: Session = {
      id,
      name: null,
      default_name: patch.cwd ? basename(patch.cwd) : id.slice(0, 8),
      cwd: null, transcript_path: null, state: "idle", last_prompt: null, last_message: null,
      source: "hook", created_at: now,
      ...cur,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      updated_at: now,
    } as Session;
    this.db.query(`INSERT OR REPLACE INTO sessions
      (id, name, default_name, cwd, transcript_path, state, last_prompt, last_message, source, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      s.id, s.name, s.default_name, s.cwd, s.transcript_path, s.state, s.last_prompt, s.last_message, s.source, s.created_at, s.updated_at);
    return s;
  }

  /** Record a hook event and move the session to its next state. */
  applyHook(e: HookInput, now = Date.now()): Session {
    const cur = this.getSession(e.session_id);
    const patch: Partial<Session> = {
      cwd: e.cwd, transcript_path: e.transcript_path,
      state: nextState(e, cur?.state ?? null) ?? cur?.state ?? "idle",
    };
    if (e.hook_event_name === "UserPromptSubmit" && typeof e.prompt === "string") {
      patch.last_prompt = e.prompt;
      // First prompt becomes the default name until the user renames the session.
      if (!cur?.last_prompt) patch.default_name = clip(e.prompt.replace(/\s+/g, " ").trim());
    }
    if (e.hook_event_name === "Stop" && typeof e.last_assistant_message === "string") patch.last_message = e.last_assistant_message;
    if (e.hook_event_name === "Notification" && typeof e.message === "string") patch.last_message = e.message;
    this.db.query("INSERT INTO events (session_id, type, payload, ts) VALUES (?,?,?,?)")
      .run(e.session_id, e.hook_event_name, JSON.stringify(e), now);
    return this.upsertSession(e.session_id, patch, now);
  }

  /** Record something the dashboard itself observed (a prompt it sent, a message Claude streamed back). */
  addEvent(sessionId: string, type: string, payload: Record<string, unknown>, now = Date.now()) {
    this.db.query("INSERT INTO events (session_id, type, payload, ts) VALUES (?,?,?,?)")
      .run(sessionId, type, JSON.stringify(payload), now);
  }

  renameSession(id: string, name: string | null): Session | null {
    const cur = this.getSession(id);
    if (!cur) return null;
    const clean = name?.trim() || null;
    this.db.query("UPDATE sessions SET name = ? WHERE id = ?").run(clean, id);
    return { ...cur, name: clean };
  }

  deleteSession(id: string) {
    this.db.query("DELETE FROM events WHERE session_id = ?").run(id);
    this.db.query("DELETE FROM sessions WHERE id = ?").run(id);
  }

  /** Prompts and notifications for the drill-in view; tool events are left out to keep it readable. */
  sessionEvents(id: string, limit = 200): EventRow[] {
    return this.db.query(`SELECT * FROM events WHERE session_id = ?
      AND type NOT IN ('PreToolUse','PostToolUse') ORDER BY id DESC LIMIT ?`).all(id, limit).reverse() as EventRow[];
  }

  addWatch(url: string, provider: string, title: string, now = Date.now()): Watch {
    const r = this.db.query(`INSERT INTO watches (url, provider, title, state, active, created_at, updated_at)
      VALUES (?,?,?,?,1,?,?) RETURNING *`).get(url, provider, title, "watching", now, now);
    return r as Watch;
  }

  listWatches(activeOnly = false): Watch[] {
    return this.db.query(`SELECT * FROM watches ${activeOnly ? "WHERE active = 1" : ""} ORDER BY updated_at DESC`).all() as Watch[];
  }

  updateWatch(id: number, patch: Partial<Pick<Watch, "state" | "detail" | "title" | "active">>, now = Date.now()): Watch | null {
    const cur = this.db.query("SELECT * FROM watches WHERE id = ?").get(id) as Watch | null;
    if (!cur) return null;
    const w = { ...cur, ...patch, updated_at: now };
    this.db.query("UPDATE watches SET state=?, detail=?, title=?, active=?, updated_at=? WHERE id=?")
      .run(w.state, w.detail, w.title, w.active, w.updated_at, id);
    return w;
  }

  deleteWatch(id: number) {
    this.db.query("DELETE FROM watches WHERE id = ?").run(id);
  }
}
