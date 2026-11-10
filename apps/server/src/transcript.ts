import { existsSync, readFileSync } from "node:fs";

export interface Note { role: "user" | "assistant"; text: string; ts: string | null }

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("\n");
}

/** Reads a Claude Code transcript (JSONL) and returns the user and assistant text turns. */
export function readNotes(path: string | null, limit = 200): Note[] {
  if (!path || !existsSync(path)) return [];
  const notes: Note[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.type !== "user" && row.type !== "assistant") continue;
      if (row.isMeta) continue;
      const text = textOf(row.message?.content).trim();
      if (text) notes.push({ role: row.type, text, ts: row.timestamp ?? null });
    } catch {
      // Skip partial or malformed lines; the file may be mid-write.
    }
  }
  return notes.slice(-limit);
}
