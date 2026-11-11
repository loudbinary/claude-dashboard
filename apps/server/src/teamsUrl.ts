export type TeamsRef =
  | { kind: "chat"; chatId: string }
  | { kind: "channel"; teamId: string; channelId: string };

/**
 * Parses a Teams deep link: /l/chat/<id>/conversations and /l/channel/<id>/<name>?groupId=<team>.
 * Ids come back percent-decoded (for example "19:abc@thread.v2" or "48:notes").
 */
export function parseTeamsUrl(raw: string): TeamsRef | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (!/(^|\.)teams\.(microsoft|live)\.com$/.test(u.hostname)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] !== "l") return null;
  try {
    if (parts[1] === "chat" && parts[2]) return { kind: "chat", chatId: decodeURIComponent(parts[2]) };
    if (parts[1] === "channel" && parts[2]) {
      const teamId = u.searchParams.get("groupId");
      if (!teamId) return null;
      return { kind: "channel", teamId, channelId: decodeURIComponent(parts[2]) };
    }
  } catch { /* malformed percent-encoding */ }
  return null;
}
