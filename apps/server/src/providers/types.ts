export type RunState = "watching" | "approval_pending" | "failed" | "succeeded" | "canceled";

export interface RunStatus { state: RunState; title: string; detail: string | null }

export interface Ref {
  provider: string;
  kind: "pr" | "run" | "incident";
  /** Short human label, e.g. "my-repo #42" or "my-project build 9876". */
  title: string;
  [k: string]: string;
}

export interface PrStatus {
  status: "active" | "completed" | "abandoned" | string;
  isDraft: boolean;
  createdBy: string;
  reviewers: { uniqueName: string; vote: number }[];
  title: string;
}

export interface Provider {
  key: string;
  /** Parse a PR or pipeline-run URL. Null when the URL is not for this provider. */
  parse(url: string): Ref | null;
  /** Current status of a pipeline run. */
  runStatus(ref: Ref): Promise<RunStatus>;
  /** Current state of a pull request (used by the Teams sweep). Optional: not every provider has it. */
  prStatus?(ref: Ref): Promise<PrStatus>;
  /** Optional details fetched for a session prompt (the `{details}` placeholder). */
  context?(ref: Ref): Promise<string>;
}

export const TERMINAL: RunState[] = ["failed", "succeeded", "canceled"];
