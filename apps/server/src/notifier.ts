import type { Broadcast } from "./app";
import type { Config } from "./config";
import type { Session, Watch } from "./db";

/**
 * Windows toast notifications for sessions and watches that need you.
 *
 * Watches every broadcast and remembers the last state of each session and watch. When one moves
 * into an attention state and is still there `delay_seconds` later, a toast is shown. In "reminder"
 * mode the toast stays on screen until you click or dismiss it, and clicking opens the dashboard on
 * that session. When the item leaves the attention state (you replied, it was removed) or is marked
 * seen in the dashboard, its toast is withdrawn, so stale toasts do not pile up. A seen item never
 * toasts again until its state changes.
 */

export interface NotificationsConfig {
  enabled: boolean;
  /** States that raise a toast. Empty = every status marked `attention: true` under ui.status. */
  states: string[];
  /** "reminder" stays on screen until clicked; "default" slides away into the notification centre. */
  scenario: "reminder" | "default";
  /** Only notify if the item is still waiting this long, so a reply you give straight away raises nothing. */
  delay_seconds: number;
  /** Address the toast opens. Empty = the dashboard's own host and port. */
  base_url?: string | null;
  /** Name the toast is shown under in Windows. */
  app_name: string;
}

export interface Toast { tag: string; title: string; body: string; url: string }
export interface ToastBackend { show(t: Toast): void; remove(tag: string): void }

type Item = { key: string; state: string; seen: boolean; title: string; body: string; url: string };
type Msg = Parameters<Broadcast>[0];

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function createNotifier(cfg: Config, backend: ToastBackend, seed: { sessions: Session[]; watches: Watch[] }) {
  const n = cfg.notifications;
  const states = new Set(n.states?.length ? n.states : Object.entries(cfg.ui.status).filter(([, s]) => s.attention).map(([k]) => k));
  const base = (n.base_url || `http://${cfg.server.host}:${cfg.server.port}`).replace(/\/$/, "");
  const label = (state: string) => cfg.ui.status[state]?.label ?? state;

  const last = new Map<string, string>();    // key -> last state seen
  const shown = new Set<string>();           // keys with a toast on screen
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  // Items already waiting when the server starts are not re-announced.
  for (const s of seed.sessions) last.set(`s:${s.id}`, s.state);
  for (const w of seed.watches) last.set(`w:${w.id}`, w.state);

  const fromSession = (s: Session): Item => ({
    key: `s:${s.id}`, state: s.state, seen: !!s.seen,
    title: `${label(s.state)}: ${clip(s.name ?? s.default_name, 60)}`,
    body: clip((s.last_message ?? "").replace(/\s+/g, " ").trim() || (s.cwd ?? ""), 180),
    url: `${base}/#session=${encodeURIComponent(s.id)}`,
  });
  const fromWatch = (w: Watch): Item => ({
    key: `w:${w.id}`, state: w.state, seen: !!w.seen,
    title: `${label(w.state)}: ${clip(w.title, 60)}`, body: w.url, url: `${base}/`,
  });

  function cancel(key: string) {
    clearTimeout(timers.get(key)); timers.delete(key);
    if (shown.delete(key)) backend.remove(key);
  }

  function observe(item: Item) {
    const prev = last.get(item.key);
    last.set(item.key, item.state);
    if (!states.has(item.state)) return cancel(item.key);
    // Seen in the dashboard: no toast, and any toast already on screen is withdrawn.
    if (item.seen) return cancel(item.key);
    if (prev === item.state) return;
    cancel(item.key);
    timers.set(item.key, setTimeout(() => {
      timers.delete(item.key);
      if (last.get(item.key) !== item.state) return;
      shown.add(item.key);
      backend.show({ tag: item.key, title: item.title, body: item.body, url: item.url });
    }, Math.max(0, n.delay_seconds) * 1000));
  }

  return function onBroadcast(msg: Msg) {
    if (msg.type === "session") observe(fromSession(msg.data as Session));
    else if (msg.type === "watch") observe(fromWatch(msg.data as Watch));
    else if (msg.type === "session_deleted") { const k = `s:${(msg.data as { id: string }).id}`; cancel(k); last.delete(k); }
    else if (msg.type === "watch_deleted") { const k = `w:${(msg.data as { id: number }).id}`; cancel(k); last.delete(k); }
  };
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/**
 * Shows toasts through Windows PowerShell 5.1, which can reach the WinRT notification API with nothing
 * installed. The app name is registered under HKCU\Software\Classes\AppUserModelId so the toast is
 * labelled with it. Toast text travels base64-encoded, so session text is never parsed as script.
 */
export function windowsToasts(appName: string, scenario: "reminder" | "default"): ToastBackend {
  const appId = "ClaudeDashboard.Notifications";
  const run = (script: string) => {
    try {
      const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
        "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdout: "ignore", stderr: "pipe" });
      child.exited.then(async (code) => { if (code) console.warn(`toast failed (${code}): ${(await new Response(child.stderr).text()).trim()}`); });
    } catch (err) { console.warn(`toast failed: ${(err as Error).message}`); }
  };
  const prelude = `$ErrorActionPreference = 'Stop'
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
$appId = '${appId}'
`;
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const text = (s: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(s)}'))`;

  return {
    show(t) {
      const toast = `<toast scenario="${scenario === "reminder" ? "reminder" : "default"}" activationType="protocol" launch="${xml(t.url)}">`
        + `<visual><binding template="ToastGeneric"><text>${xml(t.title)}</text><text>${xml(t.body)}</text></binding></visual>`
        + `<actions><action content="Open session" activationType="protocol" arguments="${xml(t.url)}"/>`
        + `<action content="Dismiss" activationType="system" arguments="dismiss"/></actions>`
        + `<audio src="ms-winsoundevent:Notification.Reminder"/></toast>`;
      run(prelude + `$key = 'HKCU:\\Software\\Classes\\AppUserModelId\\' + $appId
if (-not (Test-Path $key)) { $null = New-Item -Path $key -Force }
Set-ItemProperty -Path $key -Name DisplayName -Value (${text(appName)})
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml((${text(toast)}))
$n = New-Object Windows.UI.Notifications.ToastNotification $doc
$n.Tag = (${text(t.tag)}); $n.Group = 'claude-dashboard'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($n)
`);
    },
    remove(tag) {
      run(prelude + `[Windows.UI.Notifications.ToastNotificationManager]::History.Remove((${text(tag)}), 'claude-dashboard', $appId)\n`);
    },
  };
}
