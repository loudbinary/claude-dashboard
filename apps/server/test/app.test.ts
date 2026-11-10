import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createApp } from "../src/app";
import { deepMerge, loadConfig } from "../src/config";
import { Store } from "../src/db";
import { buildArgs, makeStreamHandler } from "../src/launcher";
import { azureDevOps, pendingApprovalStages } from "../src/providers/azureDevOps";
import { github } from "../src/providers/github";
import { nextState, normalizeHook } from "../src/state";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollOnce } from "../src/watcher";

const cfg = loadConfig(resolve(import.meta.dir, "../../../config.yaml"));
const fakeFetch = (routes: Record<string, unknown>) =>
  (async (url: string) => {
    const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
    return hit ? Response.json(hit[1]) : new Response("no", { status: 404 });
  }) as unknown as typeof fetch;

const post = (path: string, data: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(data) });

describe("config", () => {
  test("deepMerge merges objects and replaces arrays", () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { c: 3 }, l: [9] })).toEqual({ a: { b: 1, c: 3 }, l: [9] });
  });
  test("shipped config loads with its buttons", () => {
    expect(cfg.actions.map((a) => a.key)).toEqual(["review_pr", "investigate_pipeline", "watch_pipeline"]);
    expect(cfg.ui.status.needs_permission!.attention).toBe(true);
  });
});

describe("session state", () => {
  const ev = (hook_event_name: string, extra = {}) => ({ hook_event_name, session_id: "s1", ...extra });
  test("transitions", () => {
    expect(nextState(ev("UserPromptSubmit"), null)).toBe("working");
    expect(nextState(ev("Notification", { notification_type: "permission_prompt" }), "working")).toBe("needs_permission");
    expect(nextState(ev("Notification", { notification_type: "idle_prompt" }), "working")).toBe("waiting_reply");
    expect(nextState(ev("Notification", { notification_type: "auth_success" }), "working")).toBeNull();
    expect(nextState(ev("PostToolUse"), "needs_permission")).toBe("working");
    expect(nextState(ev("Stop"), "working")).toBe("waiting_reply");
    expect(nextState(ev("SessionEnd"), "waiting_reply")).toBe("done");
  });
  test("envelope format is normalized", () => {
    const e = normalizeHook({ source_app: "x", session_id: "s1", hook_event_type: "Stop", payload: { cwd: "/w" } });
    expect(e).toMatchObject({ hook_event_name: "Stop", session_id: "s1", cwd: "/w" });
    expect(normalizeHook({ nope: 1 })).toBeNull();
  });
});

describe("providers", () => {
  const ado = azureDevOps("tok");
  const gh = github("tok");
  test("Azure DevOps URLs", () => {
    expect(ado.parse("https://dev.azure.com/org/My%20Proj/_build/results?buildId=42&view=results"))
      .toMatchObject({ kind: "run", buildId: "42", base: "https://dev.azure.com/org/My%20Proj" });
    expect(ado.parse("https://org.visualstudio.com/proj/_build/results?buildId=7")).toMatchObject({ kind: "run", buildId: "7" });
    expect(ado.parse("https://dev.azure.com/org/proj/_git/repo/pullrequest/15")).toMatchObject({ kind: "pr", id: "15", repo: "repo" });
    expect(ado.parse("https://github.com/o/r/pull/1")).toBeNull();
    expect(ado.parse("not a url")).toBeNull();
  });
  test("GitHub URLs", () => {
    expect(gh.parse("https://github.com/o/r/pull/12/files")).toMatchObject({ kind: "pr", id: "12" });
    expect(gh.parse("https://github.com/o/r/actions/runs/99")).toMatchObject({ kind: "run", runId: "99", base: "https://api.github.com/repos/o/r" });
    expect(gh.parse("https://dev.azure.com/org/proj/_build/results?buildId=1")).toBeNull();
  });
  test("Azure DevOps approval detection walks up to the stage", () => {
    const records = [
      { id: "st", type: "Stage", name: "Deploy Prod" },
      { id: "cp", type: "Checkpoint", parentId: "st" },
      { id: "ap", type: "Checkpoint.Approval", parentId: "cp", state: "inProgress" },
      { id: "st2", type: "Stage", name: "Deploy Dev" },
      { id: "cp2", type: "Checkpoint", parentId: "st2" },
      { id: "ap2", type: "Checkpoint.Approval", parentId: "cp2", state: "completed" },
    ];
    expect(pendingApprovalStages(records)).toEqual(["Deploy Prod"]);
  });
  test("Azure DevOps run status", async () => {
    const ref = ado.parse("https://dev.azure.com/org/proj/_build/results?buildId=42")!;
    const waiting = azureDevOps("t", "7.1", fakeFetch({
      "/timeline": { records: [{ id: "s", type: "Stage", name: "Prod" }, { id: "c", type: "Checkpoint", parentId: "s" }, { id: "a", type: "Checkpoint.Approval", parentId: "c", state: "inProgress" }] },
      "/builds/42": { status: "inProgress", buildNumber: "1.2", definition: { name: "deploy" } },
    }));
    expect(await waiting.runStatus(ref)).toEqual({ state: "approval_pending", title: "deploy #1.2", detail: "Approval needed: Prod" });
    const done = azureDevOps("t", "7.1", fakeFetch({ "/builds/42": { status: "completed", result: "failed" } }));
    expect((await done.runStatus(ref)).state).toBe("failed");
  });
  test("GitHub run status", async () => {
    const ref = gh.parse("https://github.com/o/r/actions/runs/99")!;
    const waiting = github("t", fakeFetch({ "/pending_deployments": [{ environment: { name: "production" } }], "/runs/99": { status: "waiting", name: "CD", run_number: 5 } }));
    expect(await waiting.runStatus(ref)).toEqual({ state: "approval_pending", title: "CD #5", detail: "Approval needed: production" });
  });
});

describe("app", () => {
  function setup(launchId = "new-session") {
    const store = new Store(":memory:");
    const sent: any[] = [];
    const launched: any[] = [];
    const providers = [azureDevOps("t", "7.1", fakeFetch({ "/timeline": { records: [] }, "/builds/": { status: "completed", result: "succeeded", buildNumber: "9" } })), github("t")];
    const handle = createApp({
      cfg, store, providers, clientDir: "/nonexistent",
      broadcast: (m) => sent.push(m),
      launch: async (o) => { launched.push(o); return launchId; },
    });
    return { store, sent, launched, handle, providers };
  }

  test("hooks drive status, name and rename", async () => {
    const { handle, store, sent } = setup();
    await handle(post("/hooks", { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/work/repo", prompt: "Fix the   flaky test" }));
    expect(store.getSession("s1")).toMatchObject({ state: "working", default_name: "Fix the flaky test", last_prompt: "Fix the   flaky test" });
    await handle(post("/hooks", { hook_event_name: "Notification", session_id: "s1", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }));
    expect(store.getSession("s1")!.state).toBe("needs_permission");
    await handle(post("/hooks", { hook_event_name: "Stop", session_id: "s1", last_assistant_message: "Done." }));
    expect(store.getSession("s1")).toMatchObject({ state: "waiting_reply", last_message: "Done." });

    const res = await handle(new Request("http://127.0.0.1/api/sessions/s1", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: " Flaky test fix " }) }));
    expect((await res.json()).name).toBe("Flaky test fix");
    // A later prompt must not overwrite the user's name.
    await handle(post("/hooks", { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "another" }));
    expect(store.getSession("s1")).toMatchObject({ name: "Flaky test fix", state: "working" });
    expect(sent.filter((m) => m.type === "session").length).toBe(5);

    const detail = await (await handle(new Request("http://127.0.0.1/api/sessions/s1"))).json();
    expect(detail.events.map((e: any) => e.type)).toEqual(["UserPromptSubmit", "Notification", "Stop", "UserPromptSubmit"]);
  });

  test("review_pr launches a session with the filled prompt", async () => {
    const { handle, launched } = setup();
    const res = await handle(post("/api/actions/review_pr", { url: "https://dev.azure.com/org/proj/_git/repo/pullrequest/15" }));
    expect(res.status).toBe(201);
    expect(launched[0].prompt).toContain("https://dev.azure.com/org/proj/_git/repo/pullrequest/15");
    expect(launched[0].name).toBe("PR review: repo !15");
  });

  test("buttons reject the wrong kind of URL and unknown hosts", async () => {
    const { handle } = setup();
    expect((await handle(post("/api/actions/review_pr", { url: "https://github.com/o/r/actions/runs/1" }))).status).toBe(400);
    expect((await handle(post("/api/actions/watch_pipeline", { url: "https://example.com/x" }))).status).toBe(400);
  });

  test("watch_pipeline adds a watch and polling closes it when the run ends", async () => {
    const { handle, store, providers } = setup();
    const res = await handle(post("/api/actions/watch_pipeline", { url: "https://dev.azure.com/org/proj/_build/results?buildId=42" }));
    expect(res.status).toBe(201);
    expect(store.listWatches(true).length).toBe(1);
    const changed = await pollOnce(store, providers);
    expect(changed[0]).toMatchObject({ state: "succeeded", active: 0, title: "proj build 42 #9" });
    expect(store.listWatches(true).length).toBe(0);
  });

  test("reply is limited to dashboard-launched sessions", async () => {
    const { handle, store, launched } = setup();
    store.upsertSession("term", { source: "hook" });
    store.upsertSession("dash", { source: "dashboard", cwd: "/w" });
    expect((await handle(post("/api/sessions/term/reply", { text: "go" }))).status).toBe(409);
    expect((await handle(post("/api/sessions/dash/reply", { text: "go" }))).status).toBe(200);
    expect(launched[0]).toMatchObject({ prompt: "go", resume: "dash" });
  });

  test("new session is launched in the requested folder with the configured permissions", async () => {
    const { handle, launched } = setup();
    const res = await handle(post("/api/sessions", { prompt: "Summarize this repo", cwd: import.meta.dir, name: "Repo summary" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ session_id: "new-session" });
    expect(launched[0]).toMatchObject({ prompt: "Summarize this repo", cwd: import.meta.dir, name: "Repo summary" });
    // No permission override by default: the workspace's own Claude settings decide.
    expect(launched[0].permission_mode ?? null).toBeNull();
    expect(buildArgs(cfg, launched[0])).not.toContain("--permission-mode");
    expect((await handle(post("/api/sessions", { prompt: "x", cwd: "/no/such/folder" }))).status).toBe(400);
    expect((await handle(post("/api/sessions", { prompt: "  " }))).status).toBe(400);
  });

  test("resume matches a known session by name, else passes the name to the CLI", async () => {
    const { handle, store, launched } = setup();
    store.upsertSession("11111111-1111-1111-1111-111111111111", { source: "hook", cwd: import.meta.dir, default_name: "first prompt" });
    store.renameSession("11111111-1111-1111-1111-111111111111", "Marketplace deploy");
    let res = await handle(post("/api/sessions/resume", { session: "marketplace DEPLOY" }));
    expect(res.status).toBe(201);
    expect(launched[0]).toMatchObject({ resume: "11111111-1111-1111-1111-111111111111", cwd: import.meta.dir, prompt: "Continue where you left off." });
    res = await handle(post("/api/sessions/resume", { session: "Some terminal session", prompt: "status?", cwd: import.meta.dir }));
    expect(launched[1]).toMatchObject({ resume: "Some terminal session", prompt: "status?" });
    expect((await handle(post("/api/sessions/resume", { session: " " }))).status).toBe(400);
  });

  test("notes fall back to what the dashboard recorded when there is no transcript", async () => {
    const { handle, store } = setup();
    store.upsertSession("dash", { source: "dashboard" });
    store.addEvent("dash", "UserPromptSubmit", { prompt: "hello" });
    store.addEvent("dash", "AssistantMessage", { text: "hi there" });
    const detail = await (await handle(new Request("http://127.0.0.1/api/sessions/dash"))).json();
    expect(detail.notes.map((n: any) => [n.role, n.text])).toEqual([["user", "hello"], ["assistant", "hi there"]]);
  });

  test("cross-origin and non-JSON posts are refused", async () => {
    const { handle } = setup();
    expect((await handle(post("/api/actions/review_pr", { url: "x" }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await handle(post("/api/actions/review_pr", { url: "https://github.com/o/r/pull/1" }, { origin: "http://localhost:5173" }))).status).toBe(201);
    const plain = new Request("http://127.0.0.1/api/actions/review_pr", { method: "POST", headers: { "content-type": "text/plain" }, body: '{"url":"https://github.com/o/r/pull/1"}' });
    expect((await handle(plain)).status).toBe(400);
  });
});

describe("launcher stream", () => {
  const line = (o: unknown) => JSON.stringify(o);
  test("resumed terminal session becomes answerable and takes its Claude title", () => {
    const store = new Store(":memory:");
    let started = "";
    const h = makeStreamHandler(store, { prompt: "go on", resume: "My title" }, "/fallback", () => {}, (id) => (started = id));
    h.handle(line({ type: "system", subtype: "session_title_changed", title: "My title", session_id: "abc" }));
    h.handle(line({ type: "system", subtype: "init", session_id: "abc", cwd: "/w" }));
    h.handle(line({ type: "assistant", message: { content: [{ type: "text", text: "**done**" }] } }));
    h.handle(line({ type: "result", is_error: false, result: "**done**", session_id: "abc" }));
    expect(started).toBe("abc");
    expect(store.getSession("abc")).toMatchObject({ source: "dashboard", state: "waiting_reply", default_name: "My title", cwd: "/w", last_message: "**done**" });
    expect(store.sessionEvents("abc").map((e) => e.type)).toEqual(["UserPromptSubmit", "AssistantMessage"]);
  });
  test("an error before the session starts creates no session", () => {
    const store = new Store(":memory:");
    const h = makeStreamHandler(store, { prompt: "x", resume: "nope" }, "/f", () => {}, () => {});
    h.handle(line({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "ghost" }));
    expect(store.listSessions().length).toBe(0);
    expect(h.state.started).toBe(false);
  });
});

describe("seen", () => {
  const stateOf = (store: Store) => store.getSession("s1")!;
  test("seen survives repeat reports of the same state and resets when the state changes", async () => {
    const store = new Store(":memory:");
    store.applyHook({ hook_event_name: "Stop", session_id: "s1" });
    expect(stateOf(store)).toMatchObject({ state: "waiting_reply", seen: 0 });
    store.markSeen("s1");
    store.applyHook({ hook_event_name: "Notification", session_id: "s1", notification_type: "idle_prompt" });
    expect(stateOf(store)).toMatchObject({ state: "waiting_reply", seen: 1 });
    store.applyHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "go" });
    expect(stateOf(store)).toMatchObject({ state: "working", seen: 0 });
    store.applyHook({ hook_event_name: "Stop", session_id: "s1" });
    expect(stateOf(store)).toMatchObject({ state: "waiting_reply", seen: 0 });
  });

  test("seen does not move the updated time", () => {
    const store = new Store(":memory:");
    store.upsertSession("s1", { state: "waiting_reply" }, 1000);
    store.markSeen("s1");
    expect(stateOf(store)).toMatchObject({ seen: 1, updated_at: 1000 });
  });

  test("routes mark sessions and watches seen and broadcast the change", async () => {
    const store = new Store(":memory:");
    const sent: any[] = [];
    const handle = createApp({ cfg, store, providers: [], clientDir: "/nonexistent", broadcast: (m) => sent.push(m) });
    store.upsertSession("s1", { state: "needs_permission" });
    const w = store.addWatch("https://x", "azure_devops", "build 1");
    store.updateWatch(w.id, { state: "approval_pending" });
    expect(store.listWatches()[0]!.seen).toBe(0);

    const a = await handle(new Request("http://127.0.0.1/api/sessions/s1/seen", { method: "POST" }));
    expect((await a.json()).seen).toBe(1);
    const b = await handle(new Request(`http://127.0.0.1/api/watches/${w.id}/seen`, { method: "POST" }));
    expect((await b.json()).seen).toBe(1);
    expect(sent.map((m) => [m.type, m.data.seen])).toEqual([["session", 1], ["watch", 1]]);
    expect((await handle(new Request("http://127.0.0.1/api/sessions/nope/seen", { method: "POST" }))).status).toBe(404);
    expect((await handle(new Request("http://127.0.0.1/api/watches/999/seen", { method: "POST" }))).status).toBe(404);
    expect((await handle(new Request("http://127.0.0.1/api/sessions/s1/seen", { method: "POST", headers: { origin: "https://evil.example" } }))).status).toBe(403);
    // A watch that changes state becomes unseen again.
    store.updateWatch(w.id, { state: "succeeded" });
    expect(store.listWatches()[0]!.seen).toBe(0);
  });

  test("a database from before 'seen' existed is upgraded and keeps its rows", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cd-")), "old.sqlite");
    const old = new Database(path);
    old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT, default_name TEXT NOT NULL, cwd TEXT, transcript_path TEXT,
      state TEXT NOT NULL, last_prompt TEXT, last_message TEXT, source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO sessions VALUES ('old1', NULL, 'old session', NULL, NULL, 'waiting_reply', NULL, NULL, 'hook', 1, 1);
      CREATE TABLE watches (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, provider TEXT NOT NULL, title TEXT NOT NULL,
      state TEXT NOT NULL, detail TEXT, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
    old.close();
    const store = new Store(path);
    expect(store.getSession("old1")).toMatchObject({ default_name: "old session", seen: 0 });
    store.markSeen("old1");
    expect(new Store(path).getSession("old1")!.seen).toBe(1);
  });
});

test("launcher builds CLI arguments", () => {
  expect(buildArgs(cfg, { prompt: "hi", resume: "abc", permission_mode: "plan", allowed_tools: ["Read", "Bash(gh:*)"] }))
    .toEqual(["claude", "-p", "hi", "--output-format", "stream-json", "--verbose", "--resume", "abc", "--permission-mode", "plan", "--allowedTools", "Read,Bash(gh:*)"]);
});
