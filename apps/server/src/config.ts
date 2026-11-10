import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";

export interface StatusStyle { label: string; color: string; attention: boolean }

export interface ActionConfig {
  key: string;
  label: string;
  kind: "session" | "watch";
  accepts?: "pr" | "run";
  prompt?: string;
  name?: string;
  permission_mode?: string | null;
  allowed_tools?: string[] | null;
  cwd?: string;
}

export interface ProviderConfig { enabled: boolean; token_env?: string; api_version?: string }

export interface Config {
  server: { host: string; port: number; database_path: string };
  claude: {
    command: string; default_cwd: string; extra_args: string[];
    new_session?: { permission_mode?: string | null; allowed_tools?: string[] | null } | null;
  };
  providers: { azure_devops: ProviderConfig; github: ProviderConfig };
  watch: { poll_interval_seconds: number };
  actions: ActionConfig[];
  ui: { inactive_after_minutes: number; status: Record<string, StatusStyle> };
}

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
  return cfg;
}

/** Token for a provider, read from the environment variable the config names. */
export function tokenFor(p: ProviderConfig): string | undefined {
  return p.token_env ? process.env[p.token_env] : undefined;
}
