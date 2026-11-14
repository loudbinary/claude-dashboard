<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api, confirmRemove, type Session, type SessionDetail, type StatusStyle } from "../api";
import { popOut, selectionIn, type Snippet } from "../popout";
import DraftsPanel from "./DraftsPanel.vue";
import { stripPrComments } from "../prComments";
import Markdown from "./Markdown.vue";
import StatusChip from "./StatusChip.vue";

const props = defineProps<{ session: Session; styles: Record<string, StatusStyle> }>();
const emit = defineEmits<{ close: []; toast: [text: string, error?: boolean] }>();

const detail = ref<SessionDetail | null>(null);
const name = ref("");
const reply = ref("");
const sending = ref(false);

const panel = ref<HTMLElement | null>(null);

/**
 * Panel height, set by dragging the handle under it. Stored as a fraction of the viewport height and
 * applied in dvh, so it rescales on its own when the window is resized or a tablet flips orientation.
 * null = the default (content height, capped at 70% of the viewport). Shared by every session's panel.
 */
const HEIGHT_KEY = "claude-dashboard.detailHeight";
const MIN_FRAC = 0.2, MAX_FRAC = 0.92, STEP = 0.05;
const clampFrac = (f: number) => Math.min(MAX_FRAC, Math.max(MIN_FRAC, f));
function readFrac(): number | null {
  try { const f = Number(localStorage.getItem(HEIGHT_KEY)); return f > 0 ? clampFrac(f) : null; } catch { return null; }
}
const heightFrac = ref<number | null>(readFrac());
function saveFrac() {
  try { if (heightFrac.value === null) localStorage.removeItem(HEIGHT_KEY); else localStorage.setItem(HEIGHT_KEY, heightFrac.value.toFixed(3)); } catch { /* private window: size just isn't remembered */ }
}
const panelStyle = computed(() => heightFrac.value === null ? undefined
  : { height: `${(heightFrac.value * 100).toFixed(1)}dvh`, maxHeight: "none" });

let drag: { startY: number; startH: number } | null = null;
const resizing = ref(false);
function startResize(ev: PointerEvent) {
  if (ev.button !== 0 || !panel.value) return;
  ev.preventDefault();
  (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  drag = { startY: ev.clientY, startH: panel.value.getBoundingClientRect().height };
  resizing.value = true;
}
function onResize(ev: PointerEvent) {
  if (!drag) return;
  heightFrac.value = clampFrac((drag.startH + ev.clientY - drag.startY) / window.innerHeight);
}
function endResize() {
  if (!drag) return;
  drag = null; resizing.value = false; saveFrac();
}
function resetSize() { heightFrac.value = null; saveFrac(); }
function resizeKey(ev: KeyboardEvent) {
  const cur = heightFrac.value ?? (panel.value ? panel.value.getBoundingClientRect().height / window.innerHeight : 0.7);
  if (ev.key === "ArrowUp") heightFrac.value = clampFrac(cur - STEP);
  else if (ev.key === "ArrowDown") heightFrac.value = clampFrac(cur + STEP);
  else if (ev.key === "Home" || ev.key === "Escape") heightFrac.value = null;
  else return;
  ev.preventDefault(); saveFrac();
}
// Another tab resized its panel: follow it.
const onStorage = (ev: StorageEvent) => { if (ev.key === HEIGHT_KEY) heightFrac.value = readFrac(); };
onMounted(() => window.addEventListener("storage", onStorage));
onBeforeUnmount(() => window.removeEventListener("storage", onStorage));

/**
 * Opening a session jumps to the bottom, where the latest exchange and the reply box are.
 * Live updates keep following the bottom only if you are already there, so reading older notes is not interrupted.
 */
async function load(jump: boolean) {
  const el = panel.value;
  const follow = jump || !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  try { detail.value = await api.session(props.session.id); } catch (err) { emit("toast", (err as Error).message, true); }
  if (!follow) return;
  await nextTick();
  if (panel.value) panel.value.scrollTop = panel.value.scrollHeight;
}
watch(() => props.session.id, () => { name.value = props.session.name ?? props.session.default_name; detail.value = null; load(true); }, { immediate: true });
// Expanding a session (or opening one from a Windows toast) brings its details into view.
onMounted(() => panel.value?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
// Refresh notes whenever the session changes (new prompt, stop, notification).
watch(() => props.session.updated_at, () => load(false));

// Prompts you sent. A dashboard-started session can report the same prompt twice (once from the
// launcher, once from a hook), so identical prompts within a few seconds are shown once.
const prompts = computed(() => {
  const out: { ts: number; text: string }[] = [];
  for (const e of detail.value?.events ?? []) {
    if (e.type !== "UserPromptSubmit") continue;
    const text = JSON.parse(e.payload).prompt as string;
    const last = out[out.length - 1];
    if (last && last.text === text && e.ts - last.ts < 10_000) continue;
    out.push({ ts: e.ts, text });
  }
  return out;
});

async function saveName() {
  const next = name.value.trim();
  if (next === (props.session.name ?? props.session.default_name)) return;
  try { await api.rename(props.session.id, next); } catch (err) { emit("toast", (err as Error).message, true); }
}

async function send() {
  if (!reply.value.trim()) return;
  sending.value = true;
  try { await api.reply(props.session.id, reply.value); reply.value = ""; }
  catch (err) { emit("toast", (err as Error).message, true); }
  finally { sending.value = false; }
}

/**
 * Right-clicking selected text in the panel offers to pop it out into its own window.
 * With nothing selected (or inside the reply box) the browser's normal menu appears instead.
 */
const menu = ref<{ x: number; y: number; snippet: Snippet } | null>(null);

function onContextMenu(ev: MouseEvent) {
  if ((ev.target as HTMLElement).closest("input, textarea") || !panel.value) return;
  const snippet = selectionIn(panel.value);
  if (!snippet) return;
  ev.preventDefault();
  // Keep the menu inside the window.
  menu.value = { x: Math.min(ev.clientX, window.innerWidth - 200), y: Math.min(ev.clientY, window.innerHeight - 90), snippet };
}
const closeMenu = () => { menu.value = null; };
const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") closeMenu(); };
watch(menu, (open, was) => {
  if (open && !was) {
    window.addEventListener("pointerdown", closeMenu); window.addEventListener("blur", closeMenu); window.addEventListener("keydown", onKey);
    panel.value?.addEventListener("scroll", closeMenu);
  } else if (!open) {
    window.removeEventListener("pointerdown", closeMenu); window.removeEventListener("blur", closeMenu); window.removeEventListener("keydown", onKey);
    panel.value?.removeEventListener("scroll", closeMenu);
  }
});
onBeforeUnmount(closeMenu);

function popOutSelection() {
  const m = menu.value; closeMenu();
  if (m && !popOut(m.snippet, name.value || props.session.default_name)) emit("toast", "The browser blocked the popup window. Allow popups for the dashboard and try again.", true);
}
async function copySelection() {
  const m = menu.value; closeMenu();
  if (!m) return;
  try { await navigator.clipboard.writeText(m.snippet.text); emit("toast", "Copied"); } catch (err) { emit("toast", (err as Error).message, true); }
}

async function remove() {
  if (!confirmRemove(props.session)) return;
  try { await api.removeSession(props.session.id); emit("close"); } catch (err) { emit("toast", (err as Error).message, true); }
}
</script>

<template>
  <div class="detail-wrap" :class="{ resizing }">
  <div ref="panel" class="detail" :style="panelStyle" @contextmenu="onContextMenu">
    <div v-if="menu" class="ctx-menu" role="menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @pointerdown.stop>
      <button role="menuitem" @click="popOutSelection">Pop out selection</button>
      <button role="menuitem" @click="copySelection">Copy</button>
    </div>
    <header>
      <input v-model="name" class="rename" aria-label="Session name" @blur="saveName" @keydown.enter="($event.target as HTMLInputElement).blur()" />
      <button class="ghost" aria-label="Collapse" title="Collapse" @click="emit('close')">▴</button>
    </header>
    <div class="meta">
      <StatusChip :state="session.state" :styles="styles" :seen="!!session.seen" />
      <span>{{ session.source === "dashboard" ? "Started from dashboard" : "Terminal session" }}</span>
      <span class="mono">{{ session.cwd }}</span>
      <span class="mono">{{ session.id }}</span>
    </div>

    <DraftsPanel v-if="session.source === 'dashboard'" :session="session" @toast="(t, e) => emit('toast', t, e)" />

    <section v-if="session.last_message">
      <h3>Latest from Claude</h3>
      <Markdown :text="stripPrComments(session.last_message)" />
    </section>

    <section>
      <h3>What you sent</h3>
      <p v-if="!prompts.length" class="muted">No prompts recorded yet.</p>
      <ol class="prompts">
        <li v-for="p in prompts" :key="p.ts"><time>{{ new Date(p.ts).toLocaleTimeString() }}</time><span class="pre">{{ p.text }}</span></li>
      </ol>
    </section>

    <section>
      <h3>Session notes</h3>
      <p v-if="!detail" class="muted">Loading…</p>
      <p v-else-if="!detail.notes.length" class="muted">No transcript available for this session on this machine.</p>
      <div v-for="(n, i) in detail?.notes ?? []" :key="i" class="note" :class="n.role">
        <strong>{{ n.role === "user" ? "You" : "Claude" }}</strong>
        <Markdown v-if="n.role === 'assistant'" :text="stripPrComments(n.text)" />
        <p v-else class="pre">{{ n.text }}</p>
      </div>
    </section>

    <footer>
      <template v-if="session.source === 'dashboard'">
        <textarea v-model="reply" rows="3" placeholder="Reply to continue this session (Shift+Enter to send)"
          @keydown.shift.enter.prevent="!sending && send()" @keydown.ctrl.enter.prevent="!sending && send()" />
        <button class="action" :disabled="sending || !reply.trim()" @click="send">{{ sending ? "Sending…" : "Send reply" }}</button>
      </template>
      <p v-else class="muted">This session runs in a terminal, so reply there. Sessions started from the dashboard can be answered here.</p>
      <button class="ghost danger" @click="remove">Remove from dashboard</button>
    </footer>
  </div>
  <div class="detail-resize" role="separator" aria-orientation="horizontal" aria-label="Resize session details"
       :aria-valuenow="heightFrac === null ? undefined : Math.round(heightFrac * 100)" aria-valuemin="20" aria-valuemax="92"
       tabindex="0" title="Drag to resize. Double-click to reset."
       @pointerdown="startResize" @pointermove="onResize" @pointerup="endResize" @pointercancel="endResize"
       @lostpointercapture="endResize" @dblclick="resetSize" @keydown="resizeKey"><span aria-hidden="true"></span></div>
  </div>
</template>
