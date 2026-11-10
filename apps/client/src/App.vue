<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
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
const toasts = ref<{ id: number; text: string; error: boolean }[]>([]);
const editing = ref<string | null>(null);
const draft = ref("");

const styles = computed(() => config.value?.status ?? {});
const needsYou = (state: string) => styles.value[state]?.attention ?? false;

/** A quiet "working" session is shown as inactive after the configured time. */
function shownState(s: Session): string {
  const limit = (config.value?.inactive_after_minutes ?? 120) * 60_000;
  return s.state === "working" && now.value - s.updated_at > limit ? "idle" : s.state;
}

// Sessions that need you first, then most recently active.
const sorted = computed(() =>
  [...sessions.value].sort((a, b) => Number(needsYou(shownState(b))) - Number(needsYou(shownState(a))) || b.updated_at - a.updated_at));
const sortedWatches = computed(() =>
  [...watches.value].sort((a, b) => Number(needsYou(b.state)) - Number(needsYou(a.state)) || b.updated_at - a.updated_at));
const selected = computed(() => sessions.value.find((s) => s.id === selectedId.value) ?? null);
const attentionCount = computed(() =>
  sessions.value.filter((s) => needsYou(shownState(s))).length + watches.value.filter((w) => needsYou(w.state)).length);

function toast(text: string, error = false) {
  const id = Date.now() + Math.random();
  toasts.value.push({ id, text, error });
  setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), error ? 8000 : 4000);
}

function upsert<T extends { id: string | number }>(list: T[], item: T) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item; else list.unshift(item);
}

async function refresh() {
  try { [sessions.value, watches.value] = await Promise.all([api.sessions(), api.watches()]); }
  catch (err) { toast((err as Error).message, true); }
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

let clock: ReturnType<typeof setInterval>;
onMounted(async () => {
  try { config.value = await api.config(); } catch (err) { toast((err as Error).message, true); }
  stream(
    (m) => {
      if (m.type === "session") upsert(sessions.value, m.data as Session);
      else if (m.type === "session_deleted") sessions.value = sessions.value.filter((s) => s.id !== m.data.id);
      else if (m.type === "watch") {
        const before = watches.value.find((w) => w.id === m.data.id);
        upsert(watches.value, m.data as Watch);
        if (needsYou(m.data.state) && before?.state !== m.data.state) toast(`${m.data.title}: ${m.data.detail ?? m.data.state}`, true);
      } else if (m.type === "watch_deleted") watches.value = watches.value.filter((w) => w.id !== m.data.id);
    },
    refresh,
    (up) => (connected.value = up),
  );
  clock = setInterval(() => (now.value = Date.now()), 15_000);
});
onUnmounted(() => clearInterval(clock));
</script>

<template>
  <div class="page" :class="{ split: selected }">
    <main>
      <header class="top">
        <h1>Claude Dashboard</h1>
        <span class="count" :class="{ hot: attentionCount > 0 }">{{ attentionCount ? `${attentionCount} need you` : "Nothing needs you" }}</span>
        <span class="conn" :class="{ up: connected }">{{ connected ? "Live" : "Reconnecting…" }}</span>
      </header>

      <ActionBar :actions="config?.actions ?? []" :default-cwd="config?.default_cwd ?? ''" :sessions="sessions" @toast="toast" @started="selectedId = $event" />

      <section v-if="watches.length">
        <h2>Pipelines</h2>
        <table class="grid">
          <tbody>
            <tr v-for="w in sortedWatches" :key="w.id" :style="{ '--row': styles[w.state]?.color ?? '#98A2B3' }" :class="{ attention: needsYou(w.state) }">
              <td class="status"><StatusChip :state="w.state" :styles="styles" /></td>
              <td><a :href="w.url" target="_blank" rel="noopener">{{ w.title }}</a><div class="sub">{{ w.detail }}</div></td>
              <td class="when">{{ ago(w.updated_at, now) }}</td>
              <td class="tools"><button class="ghost" aria-label="Stop watching" @click="removeWatch(w)">✕</button></td>
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
            <tr v-for="s in sorted" :key="s.id" :style="{ '--row': styles[shownState(s)]?.color ?? '#98A2B3' }"
                :class="{ attention: needsYou(shownState(s)), selected: s.id === selectedId }" @click="selectedId = s.id">
              <td class="status"><StatusChip :state="shownState(s)" :styles="styles" /></td>
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
              <td class="tools"><button class="ghost" aria-label="Rename session" title="Rename" @click.stop="startRename(s)">✎</button></td>
            </tr>
          </tbody>
        </table>
      </section>
    </main>

    <SessionDetail v-if="selected" :session="selected" :styles="styles" @close="selectedId = null" @toast="toast" />

    <div class="toasts" role="status">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="{ error: t.error }">{{ t.text }}</div>
    </div>
  </div>
</template>
