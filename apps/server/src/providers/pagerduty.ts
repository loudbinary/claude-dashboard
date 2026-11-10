import type { Provider, Ref, RunStatus } from "./types";

type Fetch = typeof fetch;

/** Keeps the prompt bounded: alert payloads can carry large raw event bodies. */
const MAX_CONTEXT = 20_000;
const MAX_ALERTS = 10;
const MAX_LOG_ENTRIES = 25;

/**
 * PagerDuty incidents, e.g. https://acme.pagerduty.com/incidents/Q1ABC2DEF3 (any trailing path, such as /timeline).
 * Read-only: the dashboard fetches the incident, its alerts and recent log entries so the analysis session
 * starts with the alert content, whether or not that session has PagerDuty tools of its own.
 */
export function pagerduty(token: string | undefined, doFetch: Fetch = fetch): Provider {
  const headers: Record<string, string> = { Accept: "application/vnd.pagerduty+json;version=2" };
  if (token) headers.Authorization = `Token token=${token}`;

  async function get(path: string) {
    const res = await doFetch(`https://api.pagerduty.com${path}`, { headers });
    if (!res.ok) throw new Error(`PagerDuty ${res.status} for ${path}`);
    return res.json() as Promise<any>;
  }

  return {
    key: "pagerduty",

    parse(raw: string): Ref | null {
      let u: URL;
      try { u = new URL(raw.trim()); } catch { return null; }
      if (!u.hostname.endsWith(".pagerduty.com")) return null;
      const m = u.pathname.match(/^\/incidents\/([A-Z0-9]+)/i);
      if (!m) return null;
      const subdomain = u.hostname.split(".")[0]!;
      return { provider: "pagerduty", kind: "incident", title: `PagerDuty ${m[1]}`, id: m[1]!, subdomain };
    },

    async runStatus(): Promise<RunStatus> {
      throw new Error("PagerDuty incidents cannot be watched; use an analyze action instead.");
    },

    async context(ref: Ref): Promise<string> {
      if (!token) return "(The dashboard has no PagerDuty token configured, so incident details were not prefetched. Open the URL yourself.)";
      const [inc, alerts, logs] = await Promise.all([
        get(`/incidents/${ref.id}`),
        get(`/incidents/${ref.id}/alerts?limit=${MAX_ALERTS}`).catch(() => ({ alerts: [] })),
        get(`/incidents/${ref.id}/log_entries?limit=${MAX_LOG_ENTRIES}&is_overview=true`).catch(() => ({ log_entries: [] })),
      ]);
      const i = inc.incident ?? {};
      const out = {
        incident: {
          number: i.incident_number, title: i.title, status: i.status, urgency: i.urgency,
          priority: i.priority?.summary ?? null, created_at: i.created_at, updated_at: i.updated_at,
          service: i.service?.summary, escalation_policy: i.escalation_policy?.summary,
          assignees: (i.assignments ?? []).map((a: any) => a.assignee?.summary),
          description: i.description, alert_counts: i.alert_counts,
        },
        alerts: (alerts.alerts ?? []).map((a: any) => ({
          summary: a.summary, status: a.status, severity: a.severity, created_at: a.created_at,
          integration: a.integration?.summary, details: a.body?.details ?? a.body?.cef_details ?? null,
        })),
        timeline: (logs.log_entries ?? []).map((e: any) => ({ at: e.created_at, type: e.type, summary: e.summary })),
      };
      const text = JSON.stringify(out, null, 2);
      return text.length > MAX_CONTEXT ? `${text.slice(0, MAX_CONTEXT)}\n... (truncated; open the URL for the rest)` : text;
    },
  };
}
