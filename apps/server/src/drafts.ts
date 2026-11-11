/** Structured review drafts: what a PR review session hands to the dashboard, which posts them on request. */

export type Severity = "blocker" | "major" | "minor" | "nit";
export type Verdict = "clean" | "needs changes";

export interface DraftComment { file: string; line: number; end_line: number | null; severity: Severity; comment: string }
export interface ParsedDrafts { summary: string; verdict: Verdict; comments: DraftComment[] }

export const MAX_COMMENTS = 100;
export const MAX_COMMENT_LENGTH = 4000;
export const MAX_SUMMARY_LENGTH = 4000;

const SEVERITIES: Severity[] = ["blocker", "major", "minor", "nit"];
const VERDICTS: Verdict[] = ["clean", "needs changes"];
const TOP_KEYS = new Set(["summary", "verdict", "comments"]);
const COMMENT_KEYS = new Set(["file", "line", "end_line", "severity", "comment"]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isLine = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 10_000_000;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** The raw JSON of the LAST pr-comments fenced block in a message, or null when there is none. */
export function lastDraftBlock(text: string): string | null {
  const re = /```pr-comments[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```/g;
  let last: string | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m[1]!;
  return last;
}

/**
 * Validates the drafts block strictly. Returns null for a missing block or any shape that is not exactly
 * the documented one (unknown keys, wrong types, bad severity, more than MAX_COMMENTS comments). Only the
 * last block is considered: a malformed last block does not fall back to an earlier one.
 */
export function extractDrafts(text: string | null | undefined): ParsedDrafts | null {
  if (!text) return null;
  const raw = lastDraftBlock(text);
  if (raw === null) return null;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!isObj(data) || Object.keys(data).some((k) => !TOP_KEYS.has(k))) return null;
  if (typeof data.summary !== "string" || !VERDICTS.includes(data.verdict as Verdict)) return null;
  if (!Array.isArray(data.comments) || data.comments.length > MAX_COMMENTS) return null;
  const comments: DraftComment[] = [];
  for (const c of data.comments) {
    if (!isObj(c) || Object.keys(c).some((k) => !COMMENT_KEYS.has(k))) return null;
    if (typeof c.file !== "string" || !c.file.trim()) return null;
    if (!isLine(c.line)) return null;
    if (c.end_line !== undefined && (!isLine(c.end_line) || c.end_line < c.line)) return null;
    if (!SEVERITIES.includes(c.severity as Severity)) return null;
    if (typeof c.comment !== "string" || !c.comment.trim()) return null;
    const file = c.file.trim().replace(/\\/g, "/");
    comments.push({
      file: file.startsWith("/") ? file : "/" + file,
      line: c.line,
      end_line: (c.end_line as number | undefined) ?? null,
      severity: c.severity as Severity,
      comment: clip(c.comment, MAX_COMMENT_LENGTH),
    });
  }
  return { summary: clip(data.summary, MAX_SUMMARY_LENGTH), verdict: data.verdict as Verdict, comments };
}
