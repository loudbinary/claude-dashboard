export type RunState = "watching" | "approval_pending" | "failed" | "succeeded" | "canceled";

export interface RunStatus { state: RunState; title: string; detail: string | null }

export interface Ref {
  provider: string;
  kind: "pr" | "run";
  /** Short human label, e.g. "my-repo #42" or "my-project build 9876". */
  title: string;
  [k: string]: string;
}

export interface Provider {
  key: string;
  /** Parse a PR or pipeline-run URL. Null when the URL is not for this provider. */
  parse(url: string): Ref | null;
  /** Current status of a pipeline run. */
  runStatus(ref: Ref): Promise<RunStatus>;
}

export const TERMINAL: RunState[] = ["failed", "succeeded", "canceled"];
