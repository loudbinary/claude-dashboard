export type SessionState = "idle" | "working" | "needs_permission" | "waiting_reply" | "done" | "failed";

export interface HookInput {
  hook_event_name: string;
  session_id: string;
  cwd?: string;
  transcript_path?: string;
  prompt?: string;
  message?: string;
  notification_type?: string;
  last_assistant_message?: string;
  [k: string]: unknown;
}

/**
 * Next session state for a hook event, or null to leave the state as it is.
 * Red (needs_permission) and amber (waiting_reply) are the two states that need the user.
 */
export function nextState(e: HookInput, current: SessionState | null): SessionState | null {
  switch (e.hook_event_name) {
    case "SessionStart":
      return current ?? "idle";
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
    case "SubagentStart":
      return "working";
    case "PermissionRequest":
      return "needs_permission";
    case "Notification":
      if (e.notification_type === "permission_prompt") return "needs_permission";
      if (e.notification_type === "idle_prompt") return "waiting_reply";
      // Older payloads carry only a message.
      if (/permission/i.test(e.message ?? "")) return "needs_permission";
      if (/waiting for your input/i.test(e.message ?? "")) return "waiting_reply";
      return null;
    case "Stop":
      return "waiting_reply";
    case "SessionEnd":
      return "done";
    default:
      return null;
  }
}

/**
 * Accepts either Claude Code's raw hook JSON or an envelope of the form
 * { source_app, session_id, hook_event_type, payload } and returns the raw shape.
 */
export function normalizeHook(body: any): HookInput | null {
  if (!body || typeof body !== "object") return null;
  if (typeof body.hook_event_name === "string" && typeof body.session_id === "string") return body as HookInput;
  if (typeof body.hook_event_type === "string" && typeof body.session_id === "string") {
    return { ...(body.payload ?? {}), hook_event_name: body.hook_event_type, session_id: body.session_id };
  }
  return null;
}
