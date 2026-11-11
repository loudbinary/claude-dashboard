import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { startAction } from "../src/app";
import { loadConfig } from "../src/config";
import { Store } from "../src/db";
import { buildArgs } from "../src/launcher";
import { azureDevOps } from "../src/providers/azureDevOps";
import type { PrStatus } from "../src/providers/types";
import {
  buildScannerArgs, extractPrUrls, inActiveHours, needsReview, parseScannerOutput, parseTeamsUrl, sweepTick,
  type RawMessage, type Scanner, type SweepDeps,
} from "../src/teamsSweep";

const base = loadConfig(resolve(import.meta.dir, "../../../config.yaml"));
const DEV = "https://teams.microsoft.com/l/chat/19%3Ae0bdda139e2b4c07b65f3f7c1f0bbd86%40thread.v2/conversations?context=%7B%22contextType%22%3A%22chat%22%7D";
const CHAN = "https://teams.microsoft.com/l/channel/19%3An6enwOQlhi9JQDF4S2FiCwnhbNB85I2JYuEN_VeZ94A1%40thread.tacv2/General?groupId=76bbf3ca-f11c-4eff-9e59-1fcdec45afb9&tenantId=03649fb8-8961-4076-afaa-574624ebe638";
const NOTES = "https://teams.microsoft.com/l/chat/48%3Anotes/conversations?context=%7B%22contextType%22%3A%22chat%22%7D";
const ME = "me@example.com";

const WED_10AM_ET = Date.parse("2026-11-11T15:00:00Z");
const SAT_10AM_ET = Date.parse("2026-11-14T15:00:00Z");

const cfg = {
  ...base,
  teams_sweep: { ...base.teams_sweep, enabled: true, me: ME, max_concurrent_reviews: 2, sources: [{ name: "Dev", url: DEV }] },
};

const pr = (id: number, org = "intelligrc", proj = "IntelliGRC", repo = "intelli-app-configs") =>
  `https://dev.azure.com/${org}/${proj}/_git/${repo}/pullrequest/${id}`;
const key = (id: number) => `intelligrc/intelligrc/intelli-app-configs/${id}`;
const anchor = (u: string) => `<a href="${u}" title="${u}">PR</a>`;
const msg = (id: string, created: string, body: string, source = "Dev"): RawMessage =>
  ({ source, id, createdDateTime: created, from: "Alice", webUrl: `https://teams/${id}`, bodyPreview: body });

const status = (over: Partial<PrStatus> = {}): PrStatus =>
  ({ status: "active", isDraft: false, createdBy: "a@x.com", reviewers: [], title: "t", ...over });

describe("parseTeamsUrl", () => {
  test("group chat", () => expect(parseTeamsUrl(DEV)).toEqual({ kind: "chat", chatId: "19:e0bdda139e2b4c07b65f3f7c1f0bbd86@thread.v2" }));
  test("channel", () => expect(parseTeamsUrl(CHAN)).toEqual({
    kind: "channel", teamId: "76bbf3ca-f11c-4eff-9e59-1fcdec45afb9", channelId: "19:n6enwOQlhi9JQDF4S2FiCwnhbNB85I2JYuEN_VeZ94A1@thread.tacv2" }));
  test("notes chat", () => expect(parseTeamsUrl(NOTES)).toEqual({ kind: "chat", chatId: "48:notes" }));
  test("rejects other links", () => {
    expect(parseTeamsUrl("https://example.com/l/chat/x/conversations")).toBeNull();
    expect(parseTeamsUrl("https://teams.microsoft.com/l/channel/x/General")).toBeNull(); // no groupId
    expect(parseTeamsUrl("nope")).toBeNull();
  });
});

describe("extractPrUrls", () => {
  const ado = [azureDevOps("t")];
  test("anchor href plus title attribute collapse to one PR", () => {
    expect(extractPrUrls(`see ${anchor(pr(12357))} thanks`, ado)).toEqual([{ key: key(12357), url: pr(12357) }]);
  });
  test("case differences and entity-encoded ampersands dedupe", () => {
    const out = extractPrUrls(`<a href="${pr(5)}">a</a> <a href="${pr(5).toLowerCase()}">b</a> ${pr(6)}&amp;x`, ado);
    expect(out.map((o) => o.key)).toEqual([key(5), key(6)]);
  });
  test("a preview cut off in the number is ignored", () => {
    expect(extractPrUrls(`<a href="${pr(12357)}`, ado)).toEqual([]);
    expect(extractPrUrls(`<a href="${pr(12357)}">x</a>`, ado)).toHaveLength(1);
  });
  test("ignores non-PR and non-Azure links", () => {
    expect(extractPrUrls(`<a href="https://github.com/o/r/pull/1">x</a> <a href="https://dev.azure.com/o/p/_build/results?buildId=1">b</a>`, ado)).toEqual([]);
  });
});

describe("needsReview", () => {
  const cases: [string, Partial<PrStatus>, boolean][] = [
    ["active, no votes", {}, true],
    ["own PR counts", { createdBy: ME }, true],
    ["completed", { status: "completed" }, false],
    ["abandoned", { status: "abandoned" }, false],
    ["draft", { isDraft: true }, false],
    ["approved by someone", { reviewers: [{ uniqueName: "b@x.com", vote: 10 }] }, false],
    ["approved with suggestions", { reviewers: [{ uniqueName: "b@x.com", vote: 5 }] }, false],
    ["I voted waiting", { reviewers: [{ uniqueName: ME.toUpperCase(), vote: -5 }] }, false],
    ["someone rejected, I did not vote", { reviewers: [{ uniqueName: "b@x.com", vote: -10 }, { uniqueName: ME, vote: 0 }] }, true],
  ];
  for (const [name, over, want] of cases) test(name, () => expect(needsReview(status(over), ME)).toBe(want));
});

describe("active hours", () => {
  // Fixed here, not read from config: config.local.yaml overrides would change the expected answers.
  const h = { days: [1, 2, 3, 4, 5], start: "07:00", end: "19:00", time_zone: "America/New_York" };
  test("weekday business hours in Eastern time", () => {
    expect(inActiveHours(new Date(WED_10AM_ET), h)).toBe(true);
    expect(inActiveHours(new Date("2026-11-11T11:30:00Z"), h)).toBe(false); // 06:30 ET
    expect(inActiveHours(new Date("2026-11-12T00:30:00Z"), h)).toBe(false); // 19:30 ET
    expect(inActiveHours(new Date(SAT_10AM_ET), h)).toBe(false);
  });
});

describe("scanner plumbing", () => {
  test("scanner disables hooks, limits tools and uses the scanner model", () => {
    const a = buildScannerArgs(cfg, [{ name: "Dev", url: DEV, since: "2026-11-11T00:00:00.000Z" }]);
    expect(a[a.indexOf("--settings") + 1]).toBe('{"disableAllHooks":true}');
    expect(a[a.indexOf("--allowedTools") + 1]).toBe("mcp__claude_ai_Microsoft_365__read_resource,mcp__claude_ai_Microsoft_365__teams_list_channel_messages");
    expect(a[a.indexOf("--model") + 1]).toBe("haiku");
    expect(a[2]).toContain("teams:///chats/19%3Ae0bdda139e2b4c07b65f3f7c1f0bbd86%40thread.v2/messages");
  });
  test("strict output parsing", () => {
    const inner = '{"messages":[{"source":"Dev","id":"1","createdDateTime":"2026-11-11T10:00:00Z","from":"A","webUrl":"u","bodyPreview":"b"}]}';
    const good = JSON.stringify({ is_error: false, result: "```json\n" + inner + "\n```" });
    expect(parseScannerOutput(`noise\n${good}\n`)).toHaveLength(1);
    expect(() => parseScannerOutput("")).toThrow();
    expect(() => parseScannerOutput("not json")).toThrow();
    expect(() => parseScannerOutput(JSON.stringify({ is_error: true, result: "boom" }))).toThrow();
    expect(() => parseScannerOutput(JSON.stringify({ result: "no json here" }))).toThrow();
    expect(() => parseScannerOutput(JSON.stringify({ result: '{"messages":[{"id":"1"}]}' }))).toThrow();
  });
});

describe("sweep tick", () => {
  // Real Azure DevOps provider, fake network: PR ids map to canned statuses.
  function setup(opts: { statuses?: Record<string, unknown>; scanner?: Scanner; config?: typeof cfg } = {}) {
    const store = new Store(":memory:");
    const statuses: Record<string, unknown> = opts.statuses ?? {};
    const fetchFake = (async (url: string) => {
      const hit = Object.entries(statuses).find(([id]) => String(url).includes(`/pullrequests/${id}?`));
      return hit ? Response.json(hit[1]) : new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    const providers = [azureDevOps("t", "7.1", fetchFake)];
    const launched: { url: string; vars: Record<string, string> }[] = [];
    let scans = 0;
    let t = WED_10AM_ET;
    const scanner: Scanner = opts.scanner ?? (async () => []);
    const deps: SweepDeps = {
      cfg: opts.config ?? cfg, store, providers,
      scanner: async (s) => { scans++; return scanner(s); },
      launchReview: async (url, vars) => { launched.push({ url, vars }); return `sess-${launched.length}`; },
      now: () => t,
    };
    return { store, deps, launched, scans: () => scans, setNow: (x: number) => { t = x; } };
  }
  const open = (extra: Record<string, unknown> = {}) => ({ status: "active", isDraft: false, createdBy: { uniqueName: "a@x.com" }, reviewers: [], title: "t", ...extra });
  const later = (min: number) => new Date(WED_10AM_ET + min * 60_000).toISOString();
  const at = (s: { setNow: (x: number) => void }, min: number) => s.setNow(WED_10AM_ET + min * 60_000);

  test("first run sets the starting point without scanning or launching", async () => {
    const s = setup({ statuses: { 1: open() }, scanner: async () => [msg("m1", later(-5), anchor(pr(1)))] });
    const r = await sweepTick(s.deps);
    expect(s.scans()).toBe(0);
    expect(r.launched).toBe(0);
    expect(s.store.getSweepSource("Dev")!.since_ts).toBe(WED_10AM_ET);
  });

  test("launches a review for an open PR, skips old messages, dedupes repeated PRs", async () => {
    const msgs = [msg("old", later(-30), anchor(pr(9))), msg("m1", later(2), anchor(pr(1))), msg("m2", later(3), anchor(pr(1)))];
    const s = setup({ statuses: { 1: open(), 9: open() }, scanner: async () => msgs });
    await sweepTick(s.deps); // init
    at(s, 5);
    const r = await sweepTick(s.deps);
    expect(r).toMatchObject({ newPrs: 1, launched: 1 });
    expect(s.launched[0]).toEqual({ url: pr(1), vars: { source: "Dev", sender: "Alice", message_url: "https://teams/m1" } });
    expect(s.store.getSweepPr(key(1))).toMatchObject({ decision: "launched", session_id: "sess-1" });
    // next tick returns the same messages again: nothing new
    at(s, 10);
    expect(await sweepTick(s.deps)).toMatchObject({ newPrs: 0, launched: 0 });
    expect(s.launched).toHaveLength(1);
  });

  test("an edited message (same id, new text) does not launch a second review", async () => {
    let body = anchor(pr(1));
    const s = setup({ statuses: { 1: open(), 2: open() }, scanner: async () => [msg("m1", later(2), body)] });
    await sweepTick(s.deps);
    at(s, 5);
    await sweepTick(s.deps);
    body = anchor(pr(1)) + " edited " + anchor(pr(2)); // the edit adds a link to the same message id
    at(s, 10);
    await sweepTick(s.deps);
    expect(s.launched.map((l) => l.url)).toEqual([pr(1)]);
  });

  test("records why a PR was not launched", async () => {
    const s = setup({
      statuses: { 1: open({ status: "completed" }), 2: open({ isDraft: true }), 3: open({ reviewers: [{ uniqueName: "b@x.com", vote: 10 }] }), 4: open({ reviewers: [{ uniqueName: ME, vote: -5 }] }) },
      scanner: async () => [msg("m", later(2), [1, 2, 3, 4].map((i) => anchor(pr(i))).join(" "))],
    });
    await sweepTick(s.deps);
    at(s, 5);
    await sweepTick(s.deps);
    const d = (id: number) => s.store.getSweepPr(key(id))!.decision;
    expect([d(1), d(2), d(3), d(4)]).toEqual(["closed", "draft", "approved", "voted"]);
    expect(s.launched).toHaveLength(0);
  });

  test("concurrency cap leaves the rest pending for the next tick", async () => {
    const c = { ...cfg, teams_sweep: { ...cfg.teams_sweep, max_concurrent_reviews: 1 } };
    const s = setup({
      config: c, statuses: { 1: open(), 2: open() },
      scanner: async () => [msg("m", later(2), anchor(pr(1)) + anchor(pr(2)))],
    });
    await sweepTick(s.deps);
    at(s, 5);
    expect((await sweepTick(s.deps)).launched).toBe(1);
    expect(s.store.listSweepPrs("pending")).toHaveLength(1);
    // the first review is still running: the second keeps waiting
    s.store.upsertSession("sess-1", { state: "working" });
    at(s, 10);
    expect((await sweepTick(s.deps)).launched).toBe(0);
    // it finished: the waiting one goes
    s.store.upsertSession("sess-1", { state: "waiting_reply" });
    at(s, 15);
    expect((await sweepTick(s.deps)).launched).toBe(1);
    expect(s.launched.map((l) => l.url)).toEqual([pr(1), pr(2)]);
  });

  test("outside active hours nothing is scanned or launched", async () => {
    const s = setup({ statuses: { 1: open() }, scanner: async () => [msg("m", later(2), anchor(pr(1)))] });
    s.setNow(SAT_10AM_ET);
    expect(await sweepTick(s.deps)).toMatchObject({ skipped: "inactive" });
    expect(s.scans()).toBe(0);
    expect(s.store.getSweepSource("Dev")).toBeNull();
  });

  test("disabled sweep does nothing", async () => {
    const s = setup({ config: { ...cfg, teams_sweep: { ...cfg.teams_sweep, enabled: false } } });
    expect(await sweepTick(s.deps)).toMatchObject({ skipped: "disabled" });
  });

  test("a scanner error keeps the high-water mark and the next tick retries the same window", async () => {
    let fail = true;
    const s = setup({
      statuses: { 1: open() },
      scanner: async () => { if (fail) throw new Error("scanner timed out"); return [msg("m1", later(2), anchor(pr(1)))]; },
    });
    await sweepTick(s.deps);
    at(s, 5);
    const r = await sweepTick(s.deps);
    expect(r.error).toContain("timed out");
    expect(s.store.getSweepSource("Dev")).toMatchObject({ since_ts: WED_10AM_ET, last_error: "scanner timed out" });
    fail = false;
    at(s, 10);
    expect((await sweepTick(s.deps)).launched).toBe(1);
    expect(s.store.getSweepSource("Dev")!.last_error).toBeNull();
  });

  test("a PR status failure leaves the PR pending and retries", async () => {
    const s = setup({ statuses: {}, scanner: async () => [msg("m1", later(2), anchor(pr(1)))] });
    await sweepTick(s.deps);
    at(s, 5);
    const r = await sweepTick(s.deps);
    expect(r.error).toContain("PR status failed");
    expect(s.store.getSweepPr(key(1))!.decision).toBe("pending");
  });
});

describe("review model", () => {
  test("buildArgs adds --model only when set, and the action model wins over extra_args", () => {
    expect(buildArgs(cfg, { prompt: "hi" })).not.toContain("--model");
    expect(buildArgs(cfg, { prompt: "hi", model: "opus" }).join(" ")).toContain("--model opus");
    const withExtra = { ...cfg, claude: { ...cfg.claude, extra_args: ["--model", "haiku", "--foo", "--model=sonnet"] } };
    const args = buildArgs(withExtra, { prompt: "hi", model: "opus" });
    expect(args.filter((a) => a === "--model" || a.startsWith("--model="))).toEqual(["--model"]);
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args).toContain("--foo");
    // without an action model, extra_args are left alone
    expect(buildArgs(withExtra, { prompt: "hi" })).toContain("haiku");
  });

  test("review actions ship with an empty model, and review_pr_teams launches carry the configured one", async () => {
    expect(base.actions.find((a) => a.key === "review_pr")!.model ?? null).toBeNull();
    expect(base.actions.find((a) => a.key === "review_pr_teams")!.model ?? null).toBeNull();
    const action = { ...base.actions.find((a) => a.key === "review_pr_teams")!, model: "opus" };
    const launched: any[] = [];
    const deps = {
      providers: [azureDevOps("t")], broadcast: () => {},
      launch: async (o: any) => { launched.push(o); return "id"; },
    };
    const r = await startAction(deps, action, pr(7), { source: "Dev", sender: "Alice", message_url: "https://teams/m" });
    expect(r).toMatchObject({ ok: true });
    expect(launched[0].model).toBe("opus");
    expect(launched[0].prompt).toContain("Alice");
    expect(launched[0].prompt).toContain("Do NOT post any comment, vote");
    const argv = buildArgs(cfg, launched[0]);
    expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
    // unset model: no flag
    await startAction(deps, { ...action, model: "" }, pr(7));
    expect(buildArgs(cfg, launched[1])).not.toContain("--model");
  });
});
