import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import type { NotificationsConfig } from "./notifier";
import { parseTeamsUrl } from "./teamsUrl";

export interface StatusStyle { label: string; color: string; attention: boolean }

export interface ActionConfig {
  key: string;
  label: string;
  kind: "session" | "watch";
  accepts?: "pr" | "run" | "incident";
  prompt?: string;
  name?: string;
  permission_mode?: string | null;
  allowed_tools?: string[] | null;
  cwd?: string;
  /** Model for sessions this action starts (`--model`). Empty = the CLI default. */
  model?: string | null;
}

export interface TeamsSweepConfig {
  enabled: boolean;
  interval_seconds: number;
  /** days use ISO numbering: 1 = Monday ... 7 = Sunday. */
  active_hours: { days: number[]; start: string; end: string; time_zone: string };
  /** Model of the scanner that only fetches Teams messages. Unrelated to the review model (an action's `model`). */
  model: string;
  action: string;
  max_concurrent_reviews: number;
  /** Toast as soon as the sweep starts a review (the finished-review toast comes from notifications). Default true. */
  notify_started?: boolean;
  me: string;
  sources: { name: string; url: string }[];
}

export interface ProviderConfig { enabled: boolean; token_env?: string; api_version?: string }

export interface Config {
  server: { host: string; port: number; database_path: string };
  claude: {
    command: string; default_cwd: string; extra_args: string[];
    new_session?: { permission_mode?: string | null; allowed_tools?: string[] | null } | null;
  };
  providers: { azure_devops: ProviderConfig; github: ProviderConfig; pagerduty?: ProviderConfig };
  watch: { poll_interval_seconds: number };
  actions: ActionConfig[];
  ui: { inactive_after_minutes: number; status: Record<string, StatusStyle>; seen_color?: string };
  notifications: NotificationsConfig;
  teams_sweep: TeamsSweepConfig;
}

const teamsSweepDefaults: TeamsSweepConfig = {
  enabled: false, interval_seconds: 300,
  active_hours: { days: [1, 2, 3, 4, 5], start: "07:00", end: "19:00", time_zone: "America/New_York" },
  model: "haiku", action: "review_pr_teams", max_concurrent_reviews: 2, me: "", sources: [],
};

const notificationDefaults: NotificationsConfig = {
  enabled: true, states: [], scenario: "reminder", delay_seconds: 15, base_url: null, app_name: "Claude Dashboard",
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Objects merge key by key; arrays and scalars in `over` replace those in `base`. */
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge((base as Obj)[k], v);
  return out as T;
}

/** Repo root = three levels up from this file (apps/server/src). */
export const repoRoot = resolve(import.meta.dir, "../../..");

export function loadConfig(path = process.env.CLAUDE_DASHBOARD_CONFIG ?? resolve(repoRoot, "config.yaml")): Config {
  if (!existsSync(path)) throw new Error(`Config file not found: ${path}`);
  let cfg = parse(readFileSync(path, "utf8")) as Config;
  const local = path.replace(/\.ya?ml$/, ".local.yaml");
  if (existsSync(local)) cfg = deepMerge(cfg, parse(readFileSync(local, "utf8")));
  cfg.notifications = deepMerge(notificationDefaults, cfg.notifications ?? {});
  if (!["reminder", "default"].includes(cfg.notifications.scenario)) throw new Error(`notifications.scenario must be "reminder" or "default"`);

  cfg.teams_sweep = deepMerge(teamsSweepDefaults, cfg.teams_sweep ?? {});

  const base = dirname(path);
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
  cfg.server.database_path = abs(cfg.server.database_path);
  cfg.claude.default_cwd = abs(process.env.CLAUDE_DASHBOARD_CWD || cfg.claude.default_cwd || ".");
  if (process.env.CLAUDE_DASHBOARD_PORT) cfg.server.port = Number(process.env.CLAUDE_DASHBOARD_PORT);

  const keys = new Set<string>();
  for (const a of cfg.actions ?? []) {
    if (!a.key || !a.label || !["session", "watch"].includes(a.kind)) throw new Error(`Invalid action in config: ${JSON.stringify(a)}`);
    if (keys.has(a.key)) throw new Error(`Duplicate action key: ${a.key}`);
    if (a.kind === "session" && !a.prompt) throw new Error(`Action ${a.key} needs a prompt`);
    keys.add(a.key);
  }

  const ts = cfg.teams_sweep;
  for (const src of ts.sources) {
    if (!src?.name || !src.url || !parseTeamsUrl(src.url)) throw new Error(`teams_sweep source is not a Teams chat or channel link: ${JSON.stringify(src?.name ?? src)}`);
  }
  const act = cfg.actions.find((a) => a.key === ts.action);
  if (!act || act.kind !== "session" || act.accepts !== "pr") throw new Error(`teams_sweep.action "${ts.action}" must be a session action in actions: that accepts: pr`);
  return cfg;
}

/** Token for a provider, read from the environment variable the config names. */
export function tokenFor(p: ProviderConfig): string | undefined {
  return p.token_env ? process.env[p.token_env] : undefined;
}
