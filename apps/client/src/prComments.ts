/** Replaces fenced pr-comments blocks (raw JSON for the Draft comments panel) with a short note. */
export const DRAFTS_NOTE = "_Structured drafts are in the Draft comments panel._";

export function stripPrComments(text: string): string {
  return text.replace(/```pr-comments[ \t]*\r?\n[\s\S]*?\r?\n?[ \t]*```/g, DRAFTS_NOTE);
}
