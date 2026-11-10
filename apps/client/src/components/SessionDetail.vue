<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api, type Session, type SessionDetail, type StatusStyle } from "../api";
import StatusChip from "./StatusChip.vue";

const props = defineProps<{ session: Session; styles: Record<string, StatusStyle> }>();
const emit = defineEmits<{ close: []; toast: [text: string, error?: boolean] }>();

const detail = ref<SessionDetail | null>(null);
const name = ref("");
const reply = ref("");
const sending = ref(false);

async function load() {
  try { detail.value = await api.session(props.session.id); } catch (err) { emit("toast", (err as Error).message, true); }
}
watch(() => props.session.id, () => { name.value = props.session.name ?? props.session.default_name; detail.value = null; load(); }, { immediate: true });
// Refresh notes whenever the session changes (new prompt, stop, notification).
watch(() => props.session.updated_at, load);

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

async function remove() {
  try { await api.removeSession(props.session.id); emit("close"); } catch (err) { emit("toast", (err as Error).message, true); }
}
</script>

<template>
  <aside class="detail">
    <header>
      <input v-model="name" class="rename" aria-label="Session name" @blur="saveName" @keydown.enter="($event.target as HTMLInputElement).blur()" />
      <button class="ghost" aria-label="Close" @click="emit('close')">✕</button>
    </header>
    <div class="meta">
      <StatusChip :state="session.state" :styles="styles" />
      <span>{{ session.source === "dashboard" ? "Started from dashboard" : "Terminal session" }}</span>
      <span class="mono">{{ session.cwd }}</span>
      <span class="mono">{{ session.id }}</span>
    </div>

    <section v-if="session.last_message">
      <h3>Latest from Claude</h3>
      <p class="pre">{{ session.last_message }}</p>
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
        <p class="pre">{{ n.text }}</p>
      </div>
    </section>

    <footer>
      <template v-if="session.source === 'dashboard'">
        <textarea v-model="reply" rows="3" placeholder="Reply to continue this session" @keydown.ctrl.enter="send" />
        <button class="action" :disabled="sending || !reply.trim()" @click="send">{{ sending ? "Sending…" : "Send reply" }}</button>
      </template>
      <p v-else class="muted">This session runs in a terminal, so reply there. Sessions started from the dashboard can be answered here.</p>
      <button class="ghost danger" @click="remove">Remove from dashboard</button>
    </footer>
  </aside>
</template>
