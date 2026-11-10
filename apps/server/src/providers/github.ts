import type { Provider, Ref, RunStatus } from "./types";

type Fetch = typeof fetch;

export function github(token: string | undefined, doFetch: Fetch = fetch): Provider {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "claude-dashboard" };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function get(url: string) {
    const res = await doFetch(url, { headers });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
    return res.json();
  }

  return {
    key: "github",

    parse(raw: string): Ref | null {
      let u: URL;
      try { u = new URL(raw.trim()); } catch { return null; }
      // github.com, or a GitHub Enterprise host whose name contains "github".
      if (!/(^|\.)github\./.test(u.hostname) && !u.hostname.startsWith("github")) return null;
      const [owner, repo, a, b, c] = u.pathname.split("/").filter(Boolean);
      if (!owner || !repo) return null;
      const api = u.hostname === "github.com" ? "https://api.github.com" : `https://${u.hostname}/api/v3`;
      const base = `${api}/repos/${owner}/${repo}`;
      if (a === "pull" && /^\d+$/.test(b ?? "")) {
        return { provider: "github", kind: "pr", title: `${repo} #${b}`, base, id: b! };
      }
      if (a === "actions" && b === "runs" && /^\d+$/.test(c ?? "")) {
        return { provider: "github", kind: "run", title: `${repo} run ${c}`, base, runId: c! };
      }
      return null;
    },

    async runStatus(ref: Ref): Promise<RunStatus> {
      const run = await get(`${ref.base}/actions/runs/${ref.runId}`);
      const title = `${run.name ?? ref.title} #${run.run_number ?? ref.runId}`;
      if (run.status === "completed") {
        const c = run.conclusion;
        const state = c === "success" ? "succeeded" : c === "cancelled" || c === "skipped" ? "canceled" : "failed";
        return { state, title, detail: `Conclusion: ${c}` };
      }
      if (run.status === "waiting") {
        const pending = await get(`${ref.base}/actions/runs/${ref.runId}/pending_deployments`);
        const envs = (pending ?? []).map((p: any) => p.environment?.name).filter(Boolean);
        return { state: "approval_pending", title, detail: `Approval needed: ${envs.join(", ") || "environment"}` };
      }
      return { state: "watching", title, detail: `Status: ${run.status}` };
    },
  };
}
