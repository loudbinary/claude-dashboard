<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ago, api, stream, type AppConfig, type Session, type Watch } from "./api";
import ActionBar from "./components/ActionBar.vue";
import SessionDetail from "./components/SessionDetail.vue";
import StatusChip from "./components/StatusChip.vue";

const config = ref<AppConfig | null>(null);
const sessions = ref<Session[]>([]);
const watches = ref<Watch[]>([]);
const selectedId = ref<string | null>(null);
const connected = ref(false);
const now = ref(Date.now());
// A toast with a key belongs to a session or pipeline that needs you ("s:<id>" / "w:<id>"). It stays until you
// dismiss it, and dismissing it marks that item seen on the server, so it does not come back after a refresh.
const toasts = ref<{ id: number; text: string; error: boolean; key?: string }[]>([]);
// Nothing pops up until the first load has finished, so a refresh can never announce what was already there.
const loaded = ref(false);
const editing = ref<string | null>(null);
const draft = ref("");

const styles = computed(() => config.value?.status ?? {});
const needsYou = (state: string) => styles.value[state]?.attention ?? false;

/** A quiet "working" session is shown as inactive after the configured time. */
function shownState(s: Session): string {
  const limit = (config.value?.inactive_after_minutes ?? 120) * 60_000;
  return s.state === "working" && now.value - s.updated_at > limit ? "idle" : s.state;
}

/** Unseen items that need you first, then seen ones that still need you, then the rest; newest first within each. */
const rank = (attention: boolean, seen: number) => (attention ? (seen ? 1 : 0) : 2);
const sorted = computed(() =>
  [...sessions.value].sort((a, b) => rank(needsYou(shownState(a)), a.seen) - rank(needsYou(shownState(b)), b.seen) || b.updated_at - a.updated_at));
const sortedWatches = computed(() =>
  [...watches.value].sort((a, b) => rank(needsYou(a.state), a.seen) - rank(needsYou(b.state), b.seen) || b.updated_at - a.updated_at));
const isSeen = (state: string, seen: number) => needsYou(state) && !!seen;
const rowColor = (state: string, seen: number) => (isSeen(state, seen) ? "var(--seen)" : styles.value[state]?.color ?? "#98A2B3");
const selected = computed(() => sessions.value.find((s) => s.id === selectedId.value) ?? null);
const attentionCount = computed(() =>
  sessions.value.filter((s) => needsYou(shownState(s))).length + watches.value.filter((w) => needsYou(w.state)).length);
const newCount = computed(() =>
  sessions.value.filter((s) => needsYou(shownState(s)) && !s.seen).length + watches.value.filter((w) => needsYou(w.state) && !w.seen).length);

function toast(text: string, error = false, key?: string) {
  if (key) toasts.value = toasts.value.filter((t) => t.key !== key);
  const id = Date.now() + Math.random();
  toasts.value.push({ id, text, error, key });
  // Plain toasts fade on their own; ones about an item that needs you wait for you.
  if (!key) setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), error ? 8000 : 4000);
}
const dropToast = (key: string) => { toasts.value = toasts.value.filter((t) => t.key !== key); };

async function dismiss(t: { id: number; key?: string }) {
  toasts.value = toasts.value.filter((x) => x.id !== t.id);
  if (!t.key) return;
  // Persist it: the item is marked seen on the server, so it stays dismissed after a refresh or restart.
  try {
    if (t.key.startsWith("s:")) await api.markSeen(t.key.slice(2));
    else await api.markWatchSeen(Number(t.key.slice(2)));
  } catch (err) { toast((err as Error).message, true); }
}

async function markSeen(kind: "s" | "w", id: string | number) {
  try { if (kind === "s") await api.markSeen(String(id)); else await api.markWatchSeen(Number(id)); }
  catch (err) { toast((err as Error).message, true); }
}
async function markAllSeen() {
  await Promise.all([
    ...sessions.value.filter((s) => needsYou(shownState(s)) && !s.seen).map((s) => markSeen("s", s.id)),
    ...watches.value.filter((w) => needsYou(w.state) && !w.seen).map((w) => markSeen("w", w.id)),
  ]);
}

/** Looking at a session in the dashboard (tab visible, panel open) counts as seeing it. */
function autoSeen() {
  const s = selected.value;
  if (s && document.visibilityState === "visible" && needsYou(s.state) && !s.seen) markSeen("s", s.id);
}
watch(() => [selected.value?.id, selected.value?.state, selected.value?.seen], autoSeen);

function upsert<T extends { id: string | number }>(list: T[], item: T) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item; else list.unshift(item);
}

async function refresh() {
  try { [sessions.value, watches.value] = await Promise.all([api.sessions(), api.watches()]); loaded.value = true; }
  catch (err) { toast((err as Error).message, true); }
  autoSeen();
}

function startRename(s: Session) { editing.value = s.id; draft.value = s.name ?? s.default_name; }
async function commitRename(s: Session) {
  if (editing.value !== s.id) return;
  editing.value = null;
  if (draft.value.trim() === (s.name ?? s.default_name)) return;
  try { await api.rename(s.id, draft.value); } catch (err) { toast((err as Error).message, true); }
}

async function removeWatch(w: Watch) {
  try { await api.removeWatch(w.id); } catch (err) { toast((err as Error).message, true); }
}

/** `#session=<id>` (what a Windows toast opens) selects that session, then the hash is cleared. */
function openFromHash() {
  const id = new URLSearchParams(location.hash.slice(1)).get("session");
  if (!id) return;
  selectedId.value = id;
  history.replaceState(null, "", location.pathname + location.search);
}

let clock: ReturnType<typeof setInterval>;
onMounted(async () => {
  openFromHash();
  window.addEventListener("hashchange", openFromHash);
  document.addEventListener("visibilitychange", autoSeen);
  try { config.value = await api.config(); } catch (err) { toast((err as Error).message, true); }
  stream(
    (m) => {
      if (m.type === "session") {
        upsert(sessions.value, m.data as Session);
        // Seen elsewhere, or no longer waiting on you: its popup is no longer needed.
        if (m.data.seen || !needsYou(m.data.state)) dropToast(`s:${m.data.id}`);
      } else if (m.type === "session_deleted") { sessions.value = sessions.value.filter((s) => s.id !== m.data.id); dropToast(`s:${m.data.id}`); }
      else if (m.type === "watch") {
        const before = watches.value.find((w) => w.id === m.data.id);
        upsert(watches.value, m.data as Watch);
        if (m.data.seen || !needsYou(m.data.state)) dropToast(`w:${m.data.id}`);
        else if (loaded.value && before?.state !== m.data.state) toast(`${m.data.title}: ${m.data.detail ?? m.data.state}`, true, `w:${m.data.id}`);
      } else if (m.type === "watch_deleted") { watches.value = watches.value.filter((w) => w.id !== m.data.id); dropToast(`w:${m.data.id}`); }
    },
    refresh,
    (up) => (connected.value = up),
  );
  clock = setInterval(() => (now.value = Date.now()), 15_000);
});
onUnmounted(() => { clearInterval(clock); window.removeEventListener("hashchange", openFromHash); document.removeEventListener("visibilitychange", autoSeen); });
</script>

<template>
  <div class="page" :class="{ split: selected }" :style="{ '--seen': config?.seen_color }">
    <main>
      <header class="top">
        <h1>Claude Dashboard</h1>
        <span class="count" :class="{ hot: newCount > 0, calm: newCount === 0 && attentionCount > 0 }">{{
          attentionCount ? `${attentionCount} need you${newCount && newCount < attentionCount ? ` · ${newCount} new` : ""}` : "Nothing needs you" }}</span>
        <button v-if="newCount > 0" class="ghost" @click="markAllSeen">✓ Mark all seen</button>
        <span class="conn" :class="{ up: connected }">{{ connected ? "Live" : "Reconnecting…" }}</span>
      </header>

      <ActionBar :actions="config?.actions ?? []" :default-cwd="config?.default_cwd ?? ''" :sessions="sessions" @toast="toast" @started="selectedId = $event" />

      <section v-if="watches.length">
        <h2>Pipelines</h2>
        <table class="grid">
          <tbody>
            <tr v-for="w in sortedWatches" :key="w.id" :style="{ '--row': rowColor(w.state, w.seen) }"
                :class="{ attention: needsYou(w.state), seen: isSeen(w.state, w.seen) }" @click="needsYou(w.state) && !w.seen && markSeen('w', w.id)">
              <td class="status"><StatusChip :state="w.state" :styles="styles" :seen="!!w.seen" /></td>
              <td><a :href="w.url" target="_blank" rel="noopener">{{ w.title }}</a><div class="sub">{{ w.detail }}</div></td>
              <td class="when">{{ ago(w.updated_at, now) }}</td>
              <td class="tools">
                <button v-if="needsYou(w.state) && !w.seen" class="ghost" aria-label="Mark seen" title="Mark seen" @click.stop="markSeen('w', w.id)">✓</button>
                <button class="ghost" aria-label="Stop watching" title="Stop watching" @click.stop="removeWatch(w)">✕</button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>Sessions</h2>
        <p v-if="!sessions.length" class="muted empty">
          No sessions yet. Add the hooks from <code>hooks/settings.example.json</code> to your Claude Code settings, or start one with a button above.
        </p>
        <table v-else class="grid">
          <thead><tr><th>Status</th><th>Session</th><th>Last input you sent</th><th>Updated</th><th></th></tr></thead>
          <tbody>
            <tr v-for="s in sorted" :key="s.id" :style="{ '--row': rowColor(shownState(s), s.seen) }"
                :class="{ attention: needsYou(shownState(s)), seen: isSeen(shownState(s), s.seen), selected: s.id === selectedId }" @click="selectedId = s.id">
              <td class="status"><StatusChip :state="shownState(s)" :styles="styles" :seen="!!s.seen" /></td>
              <td>
                <input v-if="editing === s.id" v-model="draft" class="rename" aria-label="Session name" autofocus @click.stop
                       @blur="commitRename(s)" @keydown.enter="commitRename(s)" @keydown.esc="editing = null" />
                <template v-else>
                  <span class="name">{{ s.name ?? s.default_name }}</span>
                  <div class="sub mono">{{ s.cwd }}</div>
                </template>
              </td>
              <td class="prompt">{{ s.last_prompt }}</td>
              <td class="when">{{ ago(s.updated_at, now) }}</td>
              <td class="tools">
                <button v-if="needsYou(shownState(s)) && !s.seen" class="ghost" aria-label="Mark seen" title="Mark seen" @click.stop="markSeen('s', s.id)">✓</button>
                <button class="ghost" aria-label="Rename session" title="Rename" @click.stop="startRename(s)">✎</button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </main>

    <SessionDetail v-if="selected" :session="selected" :styles="styles" @close="selectedId = null" @toast="toast" />

    <div class="toasts" role="status">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="{ error: t.error }">
        <span>{{ t.text }}</span>
        <button class="ghost" :aria-label="t.key ? 'Dismiss and mark seen' : 'Dismiss'" :title="t.key ? 'Dismiss and mark seen' : 'Dismiss'" @click="dismiss(t)">✕</button>
      </div>
    </div>
  </div>
</template>
