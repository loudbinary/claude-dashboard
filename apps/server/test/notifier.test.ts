import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadConfig } from "../src/config";
import type { Session } from "../src/db";
import { createNotifier, type Toast } from "../src/notifier";

const base = loadConfig(resolve(import.meta.dir, "../../../config.yaml"));
const cfg = { ...base, notifications: { ...base.notifications, delay_seconds: 0, base_url: "http://dash" } };
const tick = () => new Promise((r) => setTimeout(r, 5));

function setup(seed: Session[] = []) {
  const shown: Toast[] = [], removed: string[] = [];
  const notify = createNotifier(cfg, { show: (t) => shown.push(t), remove: (t) => removed.push(t) }, { sessions: seed, watches: [] });
  return { notify, shown, removed };
}
const session = (state: string, extra: Partial<Session> = {}): Session => ({
  id: "abc", name: null, default_name: "fix the build", cwd: "C:/work", transcript_path: null, state,
  last_prompt: null, last_message: "Done. Want me to push?", source: "hook", created_at: 0, updated_at: 0, ...extra,
} as Session);

describe("notifier", () => {
  test("config defaults are filled in", () => {
    expect(base.notifications).toMatchObject({ enabled: true, scenario: "reminder", delay_seconds: 15 });
  });

  test("toasts once when a session starts needing you, with a link to it", async () => {
    const { notify, shown } = setup();
    notify({ type: "session", data: session("working") });
    notify({ type: "session", data: session("waiting_reply") });
    notify({ type: "session", data: session("waiting_reply") });
    await tick();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toEqual({ tag: "s:abc", title: "Waiting for your reply: fix the build", body: "Done. Want me to push?", url: "http://dash/#session=abc" });
  });

  test("withdraws the toast once the session moves on, and skips it if you answered within the delay", async () => {
    const { notify, shown, removed } = setup();
    notify({ type: "session", data: session("needs_permission") });
    await tick();
    notify({ type: "session", data: session("working") });
    expect(removed).toEqual(["s:abc"]);

    const slow = createNotifier({ ...cfg, notifications: { ...cfg.notifications, delay_seconds: 0.05 } },
      { show: (t) => shown.push(t), remove: () => {} }, { sessions: [], watches: [] });
    slow({ type: "session", data: session("waiting_reply", { id: "def" }) });
    slow({ type: "session", data: session("working", { id: "def" }) });
    await new Promise((r) => setTimeout(r, 80));
    expect(shown.map((t) => t.tag)).toEqual(["s:abc"]);
  });

  test("does not re-announce sessions already waiting at startup; removal clears the toast", async () => {
    const { notify, shown, removed } = setup([session("waiting_reply")]);
    notify({ type: "session", data: session("waiting_reply") });
    await tick();
    expect(shown).toHaveLength(0);
    notify({ type: "session", data: session("working") });
    notify({ type: "session", data: session("needs_permission") });
    await tick();
    notify({ type: "session_deleted", data: { id: "abc" } });
    expect(shown).toHaveLength(1);
    expect(removed).toEqual(["s:abc"]);
  });

  test("a seen session does not toast, is withdrawn when seen, and toasts again in its next episode", async () => {
    const { notify, shown, removed } = setup();
    notify({ type: "session", data: session("waiting_reply") });
    await tick();
    expect(shown).toHaveLength(1);
    // Marked seen in the dashboard: the toast on screen is withdrawn.
    notify({ type: "session", data: session("waiting_reply", { seen: 1 } as Partial<Session>) });
    expect(removed).toEqual(["s:abc"]);
    // Hooks keep reporting the same state (e.g. idle reminders): still nothing new.
    notify({ type: "session", data: session("waiting_reply", { seen: 1 } as Partial<Session>) });
    await tick();
    expect(shown).toHaveLength(1);
    // It moves on and then needs you again: a new episode, unseen, so a new toast.
    notify({ type: "session", data: session("working") });
    notify({ type: "session", data: session("waiting_reply") });
    await tick();
    expect(shown).toHaveLength(2);
  });

  test("marking an item seen before its delay ends means it never toasts", async () => {
    const shown: Toast[] = [];
    const slow = createNotifier({ ...cfg, notifications: { ...cfg.notifications, delay_seconds: 0.05 } },
      { show: (t) => shown.push(t), remove: () => {} }, { sessions: [], watches: [] });
    slow({ type: "session", data: session("needs_permission") });
    slow({ type: "session", data: session("needs_permission", { seen: 1 } as Partial<Session>) });
    await new Promise((r) => setTimeout(r, 90));
    expect(shown).toHaveLength(0);
  });
});
