import DOMPurify from "dompurify";

/** `plain` marks a selection taken from plain text (your prompts), which keeps its line breaks. */
export interface Snippet { html: string; text: string; plain: boolean }

/** The current selection, if it lies inside `root`. Copied as HTML so formatting and links survive. */
export function selectionIn(root: HTMLElement): Snippet | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const text = sel.toString();
  if (!text.trim()) return null;
  const box = document.createElement("div");
  box.appendChild(range.cloneContents());
  const anchor = range.commonAncestorContainer;
  const el = anchor instanceof Element ? anchor : anchor.parentElement;
  return { html: box.innerHTML, text, plain: !!el?.closest(".pre") };
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Opens the snippet in its own small window. The window is independent of the dashboard, so it stays
 * open after the dashboard reloads or the session panel closes. Its body is editable for your own notes.
 * Returns false if the browser blocked the popup.
 */
export function popOut(snippet: Snippet, source: string): boolean {
  const w = window.open("", `snippet-${Date.now()}`, "popup,width=520,height=420");
  if (!w) return false;

  // Reuse the dashboard's own styles (a <link> in the built app, <style> tags under Vite dev).
  const styles = [...document.querySelectorAll<HTMLElement>('link[rel="stylesheet"], style')]
    .map((n) => (n instanceof HTMLLinkElement ? `<link rel="stylesheet" href="${escape(n.href)}">` : n.outerHTML)).join("");
  const body = DOMPurify.sanitize(snippet.html, { FORBID_TAGS: ["img", "style", "form", "input", "button"] });
  const when = new Date().toLocaleString();

  w.document.open();
  w.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Snippet: ${escape(source)}</title>${styles}
<style>
  body { background: var(--panel); padding: 12px 16px; }
  .snip-head { display: flex; gap: 8px; align-items: baseline; border-bottom: 1px solid var(--line); padding-bottom: 8px; margin-bottom: 10px; }
  .snip-head .src { flex: 1; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
  .snip-body { outline: none; min-height: 60vh; }
</style></head><body>
<div class="snip-head"><span class="src">${escape(source)} · ${escape(when)}</span><button class="ghost" id="copy">Copy</button></div>
<div class="snip-body ${snippet.plain ? "pre" : "md"}" contenteditable="true" spellcheck="false">${body}</div>
</body></html>`);
  w.document.close();

  w.document.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
  const copy = w.document.getElementById("copy")!;
  copy.addEventListener("click", async () => {
    const text = (w.document.querySelector(".snip-body") as HTMLElement).innerText;
    try { await w.navigator.clipboard.writeText(text); copy.textContent = "Copied"; }
    catch { copy.textContent = "Copy failed"; }
    w.setTimeout(() => { copy.textContent = "Copy"; }, 1500);
  });
  w.focus();
  return true;
}
