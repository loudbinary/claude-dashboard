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
  /** 1 once you have seen the session in its current attention episode; reset when its state changes. */
  seen: number;
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
  /** 1 once you have seen the watch in its current state; reset when its state changes. */
  seen: number;
}

export interface SweepSource { source_key: string; since_ts: number; seen_ids: string; last_run_ts: number | null; last_error: string | null }
export type SweepDecision = "pending" | "launched" | "approved" | "closed" | "draft" | "voted";
export interface SweepPr {
  pr_key: string; url: string; source: string; sender: string | null; message_url: string | null;
  first_seen_ts: number; decision: SweepDecision; session_id: string | null; checked_ts: number | null;
}

export type DraftStatus = "pending" | "posted" | "skipped" | "failed";
export interface PrSession {
  session_id: string; pr_url: string | null; verdict: string | null; summary: string | null; summary_thread_id: string | null;
}
export interface PrDraft {
  session_id: string; idx: number; file: string; line: number; end_line: number | null; severity: string; comment: string;
  status: DraftStatus; thread_id: string | null; error: string | null; posted_at: number | null;
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
      CREATE TABLE IF NOT EXISTS removed_sessions (id TEXT PRIMARY KEY, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS watches (
        id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, provider TEXT NOT NULL, title TEXT NOT NULL,
        state TEXT NOT NULL, detail TEXT, active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sweep_sources (
        source_key TEXT PRIMARY KEY, since_ts INTEGER NOT NULL, seen_ids TEXT NOT NULL DEFAULT '[]',
        last_run_ts INTEGER, last_error TEXT);
      CREATE TABLE IF NOT EXISTS sweep_prs (
        pr_key TEXT PRIMARY KEY, url TEXT NOT NULL, source TEXT NOT NULL, sender TEXT, message_url TEXT,
        first_seen_ts INTEGER NOT NULL, decision TEXT NOT NULL, session_id TEXT, checked_ts INTEGER);
      CREATE TABLE IF NOT EXISTS pr_sessions (
        session_id TEXT PRIMARY KEY, pr_url TEXT, verdict TEXT, summary TEXT, summary_thread_id TEXT);
      CREATE TABLE IF NOT EXISTS pr_drafts (
        session_id TEXT NOT NULL, idx INTEGER NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, end_line INTEGER,
        severity TEXT NOT NULL, comment TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        thread_id TEXT, error TEXT, posted_at INTEGER, PRIMARY KEY (session_id, idx));
    `);
    // Databases from before 'seen' existed: add the column (existing rows start unseen).
    for (const table of ['sessions', 'watches']) {
      const cols = this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === 'seen')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN seen INTEGER NOT NULL DEFAULT 0`);
    }
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
      source: "hook", created_at: now, seen: 0,
      ...cur,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      updated_at: now,
    } as Session;
    // A new state is a new episode: whatever you had seen before no longer counts.
    if (cur && patch.state && patch.state !== cur.state && patch.seen === undefined) s.seen = 0;
    this.db.query(`INSERT OR REPLACE INTO sessions
      (id, name, default_name, cwd, transcript_path, state, last_prompt, last_message, source, created_at, updated_at, seen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      s.id, s.name, s.default_name, s.cwd, s.transcript_path, s.state, s.last_prompt, s.last_message, s.source, s.created_at, s.updated_at, s.seen);
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

  /** Remembers which pull request a review session is about. */
  linkSessionPr(sessionId: string, prUrl: string) {
    this.db.query(`INSERT INTO pr_sessions (session_id, pr_url) VALUES (?,?)
      ON CONFLICT(session_id) DO UPDATE SET pr_url = excluded.pr_url`).run(sessionId, prUrl);
  }

  getPrSession(sessionId: string): PrSession | null {
    return this.db.query("SELECT * FROM pr_sessions WHERE session_id = ?").get(sessionId) as PrSession | null;
  }

  listDrafts(sessionId: string): PrDraft[] {
    return this.db.query("SELECT * FROM pr_drafts WHERE session_id = ? ORDER BY idx").all(sessionId) as PrDraft[];
  }

  getDraft(sessionId: string, idx: number): PrDraft | null {
    return this.db.query("SELECT * FROM pr_drafts WHERE session_id = ? AND idx = ?").get(sessionId, idx) as PrDraft | null;
  }

  /**
   * Stores the drafts of a finished review. Only rows still pending are replaced; posted, failed and skipped
   * rows are kept, and new rows are numbered after the highest existing idx so nothing collides.
   * The summary text is refreshed unless it was already posted.
   */
  saveDrafts(sessionId: string, d: { summary: string; verdict: string; comments: { file: string; line: number; end_line: number | null; severity: string; comment: string }[] }) {
    this.db.transaction(() => {
      this.db.query(`INSERT INTO pr_sessions (session_id, verdict, summary) VALUES (?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET verdict = excluded.verdict,
          summary = CASE WHEN pr_sessions.summary_thread_id IS NULL THEN excluded.summary ELSE pr_sessions.summary END`)
        .run(sessionId, d.verdict, d.summary);
      this.db.query("DELETE FROM pr_drafts WHERE session_id = ? AND status = 'pending'").run(sessionId);
      const max = (this.db.query("SELECT COALESCE(MAX(idx), 0) AS m FROM pr_drafts WHERE session_id = ?").get(sessionId) as { m: number }).m;
      const ins = this.db.query("INSERT INTO pr_drafts (session_id, idx, file, line, end_line, severity, comment) VALUES (?,?,?,?,?,?,?)");
      d.comments.forEach((c, i) => ins.run(sessionId, max + i + 1, c.file, c.line, c.end_line, c.severity, c.comment));
    })();
  }

  markDraftPosted(sessionId: string, idx: number, comment: string, threadId: string, now = Date.now()) {
    this.db.query("UPDATE pr_drafts SET status = 'posted', comment = ?, thread_id = ?, error = NULL, posted_at = ? WHERE session_id = ? AND idx = ?")
      .run(comment, threadId, now, sessionId, idx);
  }

  markDraftFailed(sessionId: string, idx: number, comment: string, error: string) {
    this.db.query("UPDATE pr_drafts SET status = 'failed', comment = ?, error = ? WHERE session_id = ? AND idx = ?")
      .run(comment, error, sessionId, idx);
  }

  setSummaryPosted(sessionId: string, summary: string, threadId: string) {
    this.db.query("UPDATE pr_sessions SET summary = ?, summary_thread_id = ? WHERE session_id = ?").run(summary, threadId, sessionId);
  }

  /** Marks a session as seen without touching its updated time. */
  markSeen(id: string): Session | null {
    this.db.query("UPDATE sessions SET seen = 1 WHERE id = ?").run(id);
    return this.getSession(id);
  }

  renameSession(id: string, name: string | null): Session | null {
    const cur = this.getSession(id);
    if (!cur) return null;
    const clean = name?.trim() || null;
    this.db.query("UPDATE sessions SET name = ? WHERE id = ?").run(clean, id);
    return { ...cur, name: clean };
  }

  /**
   * Removes a session and remembers that it was removed, so later hook events, streamed output or
   * cross-session messages for the same id are ignored instead of bringing it back.
   */
  deleteSession(id: string, now = Date.now()) {
    this.db.query("DELETE FROM events WHERE session_id = ?").run(id);
    this.db.query("DELETE FROM sessions WHERE id = ?").run(id);
    this.db.query("INSERT OR REPLACE INTO removed_sessions (id, ts) VALUES (?, ?)").run(id, now);
  }

  isRemoved(id: string): boolean {
    return !!this.db.query("SELECT 1 FROM removed_sessions WHERE id = ?").get(id);
  }

  /** An explicit resume from the dashboard brings a removed session back. */
  unremove(id: string) {
    this.db.query("DELETE FROM removed_sessions WHERE id = ?").run(id);
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
    if (patch.state !== undefined && patch.state !== cur.state) w.seen = 0;
    this.db.query("UPDATE watches SET state=?, detail=?, title=?, active=?, updated_at=?, seen=? WHERE id=?")
      .run(w.state, w.detail, w.title, w.active, w.updated_at, w.seen, id);
    return w;
  }

  /** Marks a watch as seen without touching its updated time. */
  markWatchSeen(id: number): Watch | null {
    this.db.query("UPDATE watches SET seen = 1 WHERE id = ?").run(id);
    return this.db.query("SELECT * FROM watches WHERE id = ?").get(id) as Watch | null;
  }

  deleteWatch(id: number) {
    this.db.query("DELETE FROM watches WHERE id = ?").run(id);
  }

  // Teams sweep state ------------------------------------------------------------------------------

  getSweepSource(key: string): SweepSource | null {
    return this.db.query("SELECT * FROM sweep_sources WHERE source_key = ?").get(key) as SweepSource | null;
  }

  listSweepSources(): SweepSource[] {
    return this.db.query("SELECT * FROM sweep_sources ORDER BY source_key").all() as SweepSource[];
  }

  /** Creates the row on first sight (the starting point is "now": no backfill). */
  initSweepSource(key: string, since: number) {
    this.db.query("INSERT OR IGNORE INTO sweep_sources (source_key, since_ts, seen_ids) VALUES (?,?,'[]')").run(key, since);
  }

  /** Records a finished scan: advances the high-water mark and the seen ids (capped at 500). */
  recordSweepScan(key: string, since: number, seenIds: string[], now: number) {
    this.db.query("UPDATE sweep_sources SET since_ts=?, seen_ids=?, last_run_ts=?, last_error=NULL WHERE source_key=?")
      .run(since, JSON.stringify(seenIds.slice(-500)), now, key);
  }

  /** A failed scan keeps the high-water mark and just notes the error. */
  recordSweepError(key: string, error: string, now: number) {
    this.db.query("UPDATE sweep_sources SET last_run_ts=?, last_error=? WHERE source_key=?").run(now, error.slice(0, 500), key);
  }

  getSweepPr(key: string): SweepPr | null {
    return this.db.query("SELECT * FROM sweep_prs WHERE pr_key = ?").get(key) as SweepPr | null;
  }

  addSweepPr(pr: Omit<SweepPr, "session_id" | "checked_ts">) {
    this.db.query(`INSERT OR IGNORE INTO sweep_prs (pr_key, url, source, sender, message_url, first_seen_ts, decision)
      VALUES (?,?,?,?,?,?,?)`).run(pr.pr_key, pr.url, pr.source, pr.sender, pr.message_url, pr.first_seen_ts, pr.decision);
  }

  setSweepDecision(key: string, decision: SweepDecision, sessionId: string | null, now: number) {
    this.db.query("UPDATE sweep_prs SET decision=?, session_id=COALESCE(?, session_id), checked_ts=? WHERE pr_key=?")
      .run(decision, sessionId, now, key);
  }

  listSweepPrs(decision?: SweepDecision, limit = 50): SweepPr[] {
    return (decision
      ? this.db.query("SELECT * FROM sweep_prs WHERE decision = ? ORDER BY first_seen_ts ASC LIMIT ?").all(decision, limit)
      : this.db.query("SELECT * FROM sweep_prs ORDER BY first_seen_ts DESC LIMIT ?").all(limit)) as SweepPr[];
  }
}
