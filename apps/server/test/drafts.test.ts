import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { Store } from "../src/db";
import { extractDrafts, lastDraftBlock, MAX_COMMENT_LENGTH, MAX_COMMENTS } from "../src/drafts";
import { makeStreamHandler } from "../src/launcher";
import { azureDevOps } from "../src/providers/azureDevOps";

const cfg = loadConfig(resolve(import.meta.dir, "../../../config.yaml"));
const PR = "https://dev.azure.com/org/proj/_git/repo/pullrequest/15";

const block = (data: unknown) => "## Summary\nok\n```pr-comments\n" + (typeof data === "string" ? data : JSON.stringify(data)) + "\n```\n";
const good = {
  summary: "Looks fine overall",
  verdict: "needs changes",
  comments: [
    { file: "/src/a.ts", line: 10, severity: "major", comment: "Null check missing" },
    { file: "src/b.ts", line: 3, end_line: 5, severity: "nit", comment: "Rename" },
  ],
};

describe("draft block extraction", () => {
  test("parses a valid block and normalizes file paths", () => {
    const d = extractDrafts(block(good))!;
    expect(d.verdict).toBe("needs changes");
    expect(d.comments).toEqual([
      { file: "/src/a.ts", line: 10, end_line: null, severity: "major", comment: "Null check missing" },
      { file: "/src/b.ts", line: 3, end_line: 5, severity: "nit", comment: "Rename" },
    ]);
  });
  test("the last block wins, even over a later malformed-free earlier one", () => {
    const first = block({ ...good, summary: "first" });
    const second = block({ ...good, summary: "second", comments: [] });
    expect(extractDrafts(first + "\nmore text\n" + second)!.summary).toBe("second");
    expect(lastDraftBlock(first + second)).toContain('"second"');
  });
  test("a malformed last block does not fall back to an earlier valid one", () => {
    expect(extractDrafts(block(good) + block("{not json"))).toBeNull();
  });
  test("missing block, unknown shapes and bad fields are rejected", () => {
    expect(extractDrafts("no block here")).toBeNull();
    expect(extractDrafts(null)).toBeNull();
    expect(extractDrafts("```json\n{}\n```")).toBeNull();
    expect(extractDrafts(block({ ...good, extra: 1 }))).toBeNull();
    expect(extractDrafts(block({ ...good, verdict: "maybe" }))).toBeNull();
    expect(extractDrafts(block({ ...good, comments: "x" }))).toBeNull();
    expect(extractDrafts(block([]))).toBeNull();
    const c = good.comments[0]!;
    for (const bad of [
      { ...c, severity: "critical" }, { ...c, line: 0 }, { ...c, line: 1.5 }, { ...c, line: "3" }, { ...c, file: "" },
      { ...c, comment: "  " }, { ...c, end_line: 2 }, { ...c, surprise: true }, "str",
    ]) {
      expect(extractDrafts(block({ ...good, comments: [bad] }))).toBeNull();
    }
  });
  test("caps: too many comments are rejected, long comments are clipped", () => {
    const many = Array.from({ length: MAX_COMMENTS + 1 }, () => good.comments[0]);
    expect(extractDrafts(block({ ...good, comments: many }))).toBeNull();
    const exactly = Array.from({ length: MAX_COMMENTS }, () => good.comments[0]);
    expect(extractDrafts(block({ ...good, comments: exactly }))!.comments.length).toBe(MAX_COMMENTS);
    const long = { ...good.comments[0], comment: "x".repeat(MAX_COMMENT_LENGTH + 500) };
    expect(extractDrafts(block({ ...good, comments: [long] }))!.comments[0]!.comment.length).toBe(MAX_COMMENT_LENGTH);
  });
});

describe("stream handler stores drafts", () => {
  const line = (o: unknown) => JSON.stringify(o);
  function finish(store: Store, text: string, opts: { resume?: string } = {}) {
    const h = makeStreamHandler(store, { prompt: "go", ...opts }, "/w", () => {}, () => {});
    h.handle(line({ type: "system", subtype: "init", session_id: "s1", cwd: "/w" }));
    h.handle(line({ type: "result", is_error: false, result: text, session_id: "s1" }));
  }
  test("a finished review stores pending drafts; no block stores none", () => {
    const store = new Store(":memory:");
    finish(store, block(good));
    expect(store.listDrafts("s1").map((d) => [d.idx, d.status, d.file])).toEqual([[1, "pending", "/src/a.ts"], [2, "pending", "/src/b.ts"]]);
    expect(store.getPrSession("s1")).toMatchObject({ verdict: "needs changes", summary: "Looks fine overall" });
    const other = new Store(":memory:");
    finish(other, "just prose");
    expect(other.listDrafts("s1")).toEqual([]);
    expect(other.getPrSession("s1")).toBeNull();
  });
  test("re-parsing after a resume replaces only pending rows", () => {
    const store = new Store(":memory:");
    finish(store, block(good));
    store.markDraftPosted("s1", 1, "Null check missing", "77");
    finish(store, block({ ...good, comments: [{ file: "/c.ts", line: 1, severity: "minor", comment: "New one" }] }), { resume: "s1" });
    const rows = store.listDrafts("s1");
    expect(rows.map((d) => [d.idx, d.status, d.file])).toEqual([[1, "posted", "/src/a.ts"], [2, "pending", "/c.ts"]]);
    // A later finish with no valid block leaves what is there.
    finish(store, "thanks!", { resume: "s1" });
    expect(store.listDrafts("s1").length).toBe(2);
  });
  test("an errored run stores no drafts", () => {
    const store = new Store(":memory:");
    const h = makeStreamHandler(store, { prompt: "go" }, "/w", () => {}, () => {});
    h.handle(line({ type: "system", subtype: "init", session_id: "s1" }));
    h.handle(line({ type: "result", is_error: true, result: block(good), session_id: "s1" }));
    expect(store.listDrafts("s1")).toEqual([]);
  });
});

describe("azure devops postThread", () => {
  const ref = { provider: "azure_devops", kind: "pr", title: "repo !15", base: "https://dev.azure.com/org/proj", repo: "repo", id: "15" } as const;
  function recorder(status = 200, body: unknown = { id: 42 }) {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return Response.json(body, { status }); }) as unknown as typeof fetch;
    return { calls, f };
  }
  test("file thread uses threadContext on the right side", async () => {
    const { calls, f } = recorder();
    const id = await azureDevOps("tok", "7.1", f).postThread!(ref, { content: "hi", filePath: "/src/a.ts", line: 10, endLine: 12 });
    expect(id).toBe("42");
    expect(calls[0]!.url).toBe("https://dev.azure.com/org/proj/_apis/git/repositories/repo/pullRequests/15/threads?api-version=7.1");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      comments: [{ parentCommentId: 0, content: "hi", commentType: 1 }],
      status: "active",
      threadContext: { filePath: "/src/a.ts", rightFileStart: { line: 10, offset: 1 }, rightFileEnd: { line: 12, offset: 1 } },
    });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toStartWith("Basic ");
  });
  test("single line ends where it starts; general thread has no threadContext", async () => {
    const { calls, f } = recorder();
    const ado = azureDevOps("tok", "7.1", f);
    await ado.postThread!(ref, { content: "a", filePath: "/x.ts", line: 4 });
    expect(JSON.parse(String(calls[0]!.init.body)).threadContext.rightFileEnd).toEqual({ line: 4, offset: 1 });
    await ado.postThread!(ref, { content: "summary" });
    const general = JSON.parse(String(calls[1]!.init.body));
    expect(general).toEqual({ comments: [{ parentCommentId: 0, content: "summary", commentType: 1 }], status: "active" });
    expect("threadContext" in general).toBe(false);
  });
  test("non-2xx and 203 throw", async () => {
    await expect(azureDevOps("t", "7.1", recorder(401).f).postThread!(ref, { content: "x" })).rejects.toThrow("401");
    await expect(azureDevOps("t", "7.1", recorder(203, {}).f).postThread!(ref, { content: "x" })).rejects.toThrow("203");
  });
});

describe("post drafts endpoint", () => {
  const req = (path: string, method = "GET", data?: unknown, headers: Record<string, string> = {}) =>
    new Request(`http://127.0.0.1${path}`, { method, headers: { ...(data ? { "content-type": "application/json" } : {}), ...headers }, body: data ? JSON.stringify(data) : undefined });

  function setup(opts: { prStatus?: string; failOn?: (body: any) => boolean; footer?: string } = {}) {
    const store = new Store(":memory:");
    const posts: any[] = [];
    let next = 100;
    const f = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (opts.failOn?.(body)) return new Response("boom", { status: 500 });
        posts.push(body);
        return Response.json({ id: next++ });
      }
      return Response.json({ status: opts.prStatus ?? "active", title: "t", createdBy: {}, reviewers: [] });
    }) as unknown as typeof fetch;
    const c = { ...cfg, pr_comments: { footer: opts.footer ?? "_footer_" } };
    const handle = createApp({ cfg: c, store, providers: [azureDevOps("t", "7.1", f)], broadcast: () => {}, clientDir: "/nonexistent" });
    store.upsertSession("s1", { source: "dashboard", state: "waiting_reply" });
    store.linkSessionPr("s1", PR);
    store.saveDrafts("s1", { summary: "Sum", verdict: "needs changes", comments: [
      { file: "/a.ts", line: 1, end_line: null, severity: "major", comment: "one" },
      { file: "/b.ts", line: 2, end_line: 4, severity: "nit", comment: "two" },
      { file: "/c.ts", line: 3, end_line: null, severity: "minor", comment: "three" },
    ] });
    return { store, handle, posts };
  }

  test("GET returns the PR link, verdict, summary and drafts", async () => {
    const { handle } = setup();
    const out = await (await handle(req("/api/sessions/s1/drafts"))).json();
    expect(out).toMatchObject({ pr_url: PR, verdict: "needs changes", summary: "Sum" });
    expect(out.drafts.map((d: any) => d.idx)).toEqual([1, 2, 3]);
    expect((await handle(req("/api/sessions/nope/drafts"))).status).toBe(404);
  });

  test("posts only the selected items with edited text and the footer", async () => {
    const { handle, posts, store } = setup();
    const res = await handle(req("/api/sessions/s1/drafts/post", "POST", { items: [{ idx: 1, comment: "edited one" }, { idx: 3, comment: "three" }] }));
    expect(res.status).toBe(200);
    expect(posts.length).toBe(2);
    expect(posts[0].comments[0].content).toBe("edited one\n\n_footer_");
    expect(posts[0].threadContext.filePath).toBe("/a.ts");
    expect(posts[1].threadContext.rightFileStart.line).toBe(3);
    const rows = store.listDrafts("s1");
    expect(rows.map((d) => d.status)).toEqual(["posted", "pending", "posted"]);
    expect(rows[0]).toMatchObject({ comment: "edited one", thread_id: "100" });
  });

  test("posted items are not reposted", async () => {
    const { handle, posts } = setup();
    await handle(req("/api/sessions/s1/drafts/post", "POST", { items: [{ idx: 1, comment: "one" }] }));
    const again = await (await handle(req("/api/sessions/s1/drafts/post", "POST", { items: [{ idx: 1, comment: "one" }, { idx: 2, comment: "two" }] }))).json();
    expect(again.skipped).toEqual([1]);
    expect(again.posted.map((p: any) => p.idx)).toEqual([2]);
    expect(posts.length).toBe(2);
  });

  test("summary is a general thread with the footer, posted once", async () => {
    const { handle, posts, store } = setup();
    const out = await (await handle(req("/api/sessions/s1/drafts/post", "POST", { items: [], include_summary: true, summary: "Edited summary" }))).json();
    expect(out.summary).toEqual({ thread_id: "100" });
    expect(posts[0].comments[0].content).toBe("Edited summary\n\n_footer_");
    expect("threadContext" in posts[0]).toBe(false);
    expect(store.getPrSession("s1")!.summary_thread_id).toBe("100");
    await handle(req("/api/sessions/s1/drafts/post", "POST", { items: [], include_summary: true }));
    expect(posts.length).toBe(1);
  });

  test("an empty footer disables it", async () => {
    const { handle, posts } = setup({ footer: "" });
    await handle(req("/api/sessions/s1/drafts/post", "POST", { items: [{ idx: 1, comment: "one" }] }));
    expect(posts[0].comments[0].content).toBe("one");
  });

  test("completed or abandoned PRs are refused and nothing is posted", async () => {
    for (const prStatus of ["completed", "abandoned"]) {
      const { handle, posts, store } = setup({ prStatus });
      const res = await handle(req("/api/sessions/s1/drafts/post", "POST", { items: [{ idx: 1, comment: "one" }] }));
      expect(res.status).toBe(409);
      expect(posts.length).toBe(0);
      expect(store.listDrafts("s1")[0]!.status).toBe("pending");
      expect(store.sessionEvents("s1").some((e) => e.type === "PrCommentsPosted")).toBe(false);
    }
  });

  test("partial failure is reported, recorded, and retryable", async () => {
    let fail = true;
    const { handle, store } = setup({ failOn: (b) => fail && b.threadContext?.filePath === "/b.ts" });
    const out = await (await handle(req("/api/sessions/s1/drafts/post", "POST", { items: [{ idx: 1, comment: "one" }, { idx: 2, comment: "two" }, { idx: 3, comment: "three" }] }))).json();
    expect(out.posted.map((p: any) => p.idx)).toEqual([1, 3]);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]).toMatchObject({ idx: 2 });
    expect(store.listDrafts("s1").map((d) => d.status)).toEqual(["posted", "failed", "posted"]);
    expect(store.getDraft("s1", 2)!.error).toContain("500");
    fail = false;
    const retry = await (await handle(req("/api/sessions/s1/drafts/post", "POST", { items: [{ idx: 2, comment: "two" }] }))).json();
    expect(retry.posted.map((p: any) => p.idx)).toEqual([2]);
    expect(store.getDraft("s1", 2)!.status).toBe("posted");
  });

  test("writes a PrCommentsPosted audit event", async () => {
    const { handle, store } = setup({ failOn: (b) => b.threadContext?.filePath === "/b.ts" });
    await handle(req("/api/sessions/s1/drafts/post", "POST", { items: [{ idx: 1, comment: "one" }, { idx: 2, comment: "two" }] }));
    const ev = store.sessionEvents("s1").filter((e) => e.type === "PrCommentsPosted");
    expect(ev.length).toBe(1);
    const p = JSON.parse(ev[0]!.payload);
    expect(p).toMatchObject({ pr_url: PR, idx: [1], thread_ids: ["100"] });
    expect(p.failures).toHaveLength(1);
    expect(p.failures[0].idx).toBe(2);
    expect(Number.isNaN(Date.parse(p.ts))).toBe(false);
  });

  test("bad bodies, unknown drafts, unlinked sessions and cross-origin posts are refused", async () => {
    const { handle, store } = setup();
    expect((await handle(req("/api/sessions/s1/drafts/post", "POST", { items: [{ idx: 99, comment: "x" }] }))).status).toBe(400);
    expect((await handle(req("/api/sessions/s1/drafts/post", "POST", { items: [{ idx: 1, comment: " " }] }))).status).toBe(400);
    expect((await handle(req("/api/sessions/s1/drafts/post", "POST", { nope: 1 }))).status).toBe(400);
    store.upsertSession("s2", {});
    expect((await handle(req("/api/sessions/s2/drafts/post", "POST", { items: [] }))).status).toBe(409);
    const cross = await handle(req("/api/sessions/s1/drafts/post", "POST", { items: [{ idx: 1, comment: "one" }] }, { origin: "https://evil.example" }));
    expect(cross.status).toBe(403);
    expect(store.getDraft("s1", 1)!.status).toBe("pending");
  });
});

describe("session to PR link", () => {
  test("startAction through the review buttons records the PR url", async () => {
    const store = new Store(":memory:");
    const handle = createApp({
      cfg, store, providers: [azureDevOps("t")], broadcast: () => {}, clientDir: "/nonexistent",
      launch: async () => "sess-1",
    });
    const res = await handle(new Request("http://127.0.0.1/api/actions/review_pr", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: PR }) }));
    expect(res.status).toBe(201);
    expect(store.getPrSession("sess-1")!.pr_url).toBe(PR);
  });
  test("non-PR actions record no link", async () => {
    const store = new Store(":memory:");
    const handle = createApp({
      cfg, store, providers: [azureDevOps("t", "7.1", (async () => Response.json({ status: "completed", result: "succeeded" })) as unknown as typeof fetch)],
      broadcast: () => {}, clientDir: "/nonexistent", launch: async () => "sess-2",
    });
    await handle(new Request("http://127.0.0.1/api/actions/investigate_pipeline", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://dev.azure.com/org/proj/_build/results?buildId=42" }) }));
    expect(store.getPrSession("sess-2")).toBeNull();
  });
});
