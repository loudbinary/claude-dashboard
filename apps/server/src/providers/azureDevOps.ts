import type { PrStatus, Provider, Ref, RunStatus } from "./types";

type Fetch = typeof fetch;

/** Stage names that have an approval check still open, from a build timeline. */
export function pendingApprovalStages(records: any[]): string[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const stages: string[] = [];
  for (const r of records) {
    if (r.type !== "Checkpoint.Approval" || r.state === "completed") continue;
    // Checkpoint.Approval -> Checkpoint -> Stage
    let p = byId.get(r.parentId);
    while (p && p.type !== "Stage") p = byId.get(p.parentId);
    stages.push(p?.name ?? "unknown stage");
  }
  return [...new Set(stages)];
}

export function azureDevOps(token: string | undefined, apiVersion = "7.1", doFetch: Fetch = fetch): Provider {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = "Basic " + Buffer.from(":" + token).toString("base64");

  async function get(url: string) {
    const res = await doFetch(url, { headers });
    // A sign-in page (HTML 203) comes back when the token is missing or lacks scope.
    if (!res.ok || res.status === 203) throw new Error(`Azure DevOps ${res.status} for ${url}`);
    return res.json();
  }

  return {
    key: "azure_devops",

    parse(raw: string): Ref | null {
      let u: URL;
      try { u = new URL(raw.trim()); } catch { return null; }
      const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      let org: string, rest: string[];
      if (u.hostname === "dev.azure.com") [org, ...rest] = parts as [string, ...string[]];
      else if (u.hostname.endsWith(".visualstudio.com")) { org = u.hostname.split(".")[0]!; rest = parts; }
      else return null;
      const project = rest[0];
      if (!org || !project) return null;
      const base = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}`;

      const buildId = u.searchParams.get("buildId");
      if (rest[1] === "_build" && buildId && /^\d+$/.test(buildId)) {
        return { provider: "azure_devops", kind: "run", title: `${project} build ${buildId}`, base, buildId };
      }
      const pr = rest.indexOf("pullrequest");
      if (rest[1] === "_git" && rest[2] && pr === 3 && /^\d+$/.test(rest[4] ?? "")) {
        return { provider: "azure_devops", kind: "pr", title: `${rest[2]} !${rest[4]}`, base, repo: rest[2], id: rest[4]! };
      }
      return null;
    },

    async prStatus(ref: Ref): Promise<PrStatus> {
      const pr = await get(`${ref.base}/_apis/git/repositories/${encodeURIComponent(ref.repo!)}/pullrequests/${ref.id}?api-version=${apiVersion}`);
      return {
        status: String(pr.status ?? ""),
        isDraft: !!pr.isDraft,
        createdBy: pr.createdBy?.uniqueName ?? "",
        reviewers: (pr.reviewers ?? []).map((r: any) => ({ uniqueName: r.uniqueName ?? "", vote: Number(r.vote ?? 0) })),
        title: pr.title ?? ref.title,
      };
    },

    async runStatus(ref: Ref): Promise<RunStatus> {
      const q = `api-version=${apiVersion}`;
      const build = await get(`${ref.base}/_apis/build/builds/${ref.buildId}?${q}`);
      const title = `${build.definition?.name ?? ref.title} #${build.buildNumber ?? ref.buildId}`;
      if (build.status === "completed") {
        const r = build.result;
        const state = r === "succeeded" || r === "partiallySucceeded" ? "succeeded" : r === "canceled" ? "canceled" : "failed";
        return { state, title, detail: `Result: ${r}` };
      }
      const timeline = await get(`${ref.base}/_apis/build/builds/${ref.buildId}/timeline?${q}`);
      const stages = pendingApprovalStages(timeline?.records ?? []);
      if (stages.length) return { state: "approval_pending", title, detail: `Approval needed: ${stages.join(", ")}` };
      return { state: "watching", title, detail: `Status: ${build.status}` };
    },
  };
}
