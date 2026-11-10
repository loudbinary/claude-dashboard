<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api, type Action, type Session } from "../api";

const props = defineProps<{ actions: Action[]; defaultCwd: string; sessions: Session[] }>();
const emit = defineEmits<{ toast: [text: string, error?: boolean]; started: [sessionId: string] }>();

const manual = ref("");
const busy = ref<string | null>(null);
const open = ref<"new" | "resume" | null>(null);
const toggle = (which: "new" | "resume") => (open.value = open.value === which ? null : which);

// New session form
const prompt = ref("");
const cwd = ref("");
const name = ref("");
watch(() => props.defaultCwd, (v) => { if (!cwd.value) cwd.value = v; }, { immediate: true });

// Resume session form
const resumeName = ref("");
const resumePrompt = ref("");
const resumeCwd = ref("");
const names = computed(() => [...new Set(props.sessions.map((s) => s.name ?? s.default_name))]);
const match = computed(() => {
  const want = resumeName.value.trim().toLowerCase();
  return want ? props.sessions.find((s) => s.id === resumeName.value.trim() || (s.name ?? s.default_name).toLowerCase() === want) : undefined;
});

/** Typed URL wins; otherwise read the clipboard (the browser asks for permission the first time). */
async function getUrl(): Promise<string> {
  if (manual.value.trim()) return manual.value.trim();
  try {
    return (await navigator.clipboard.readText()).trim();
  } catch {
    throw new Error("Could not read the clipboard. Allow clipboard access for this page, or paste the URL into the box.");
  }
}

async function run(a: Action) {
  busy.value = a.key;
  try {
    const url = await getUrl();
    if (!url) throw new Error("The clipboard is empty. Copy a pull request, pipeline run or PagerDuty incident URL first.");
    await api.runAction(a.key, url);
    emit("toast", `${a.label}: started for ${url}`);
    manual.value = "";
  } catch (err) {
    emit("toast", (err as Error).message, true);
  } finally {
    busy.value = null;
  }
}

async function start() {
  if (!prompt.value.trim()) return;
  busy.value = "new";
  try {
    const { session_id } = await api.newSession(prompt.value, cwd.value, name.value);
    emit("started", session_id);
    prompt.value = ""; name.value = ""; open.value = null;
  } catch (err) {
    emit("toast", (err as Error).message, true);
  } finally {
    busy.value = null;
  }
}

async function resume() {
  if (!resumeName.value.trim()) return;
  busy.value = "resume";
  try {
    const { session_id } = await api.resumeSession(resumeName.value, resumePrompt.value, resumeCwd.value);
    emit("started", session_id);
    resumeName.value = ""; resumePrompt.value = ""; resumeCwd.value = ""; open.value = null;
  } catch (err) {
    emit("toast", (err as Error).message, true);
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <div class="actions">
    <button class="action primary" :aria-expanded="open === 'new'" @click="toggle('new')">＋ New session</button>
    <button class="action primary" :aria-expanded="open === 'resume'" @click="toggle('resume')">↻ Resume session</button>
    <button v-for="a in actions" :key="a.key" class="action" :disabled="busy !== null" @click="run(a)">
      {{ busy === a.key ? "Starting…" : a.label }}
    </button>
    <input v-model="manual" class="url" type="url" placeholder="URL (leave empty to use the clipboard)" aria-label="URL for the action buttons" />
  </div>

  <form v-if="open === 'new'" class="new-session" @submit.prevent="start">
    <textarea v-model="prompt" rows="3" placeholder="What should Claude do?" aria-label="Prompt" autofocus @keydown.ctrl.enter="start" />
    <div class="row">
      <label>Working folder <input v-model="cwd" class="mono" aria-label="Working folder" /></label>
      <label>Name (optional) <input v-model="name" aria-label="Session name" /></label>
      <button class="action primary" type="submit" :disabled="busy !== null || !prompt.trim()">{{ busy === "new" ? "Starting…" : "Start session" }}</button>
    </div>
  </form>

  <form v-if="open === 'resume'" class="new-session" @submit.prevent="resume">
    <div class="row">
      <label>Session name or id
        <input v-model="resumeName" list="session-names" aria-label="Session name or id" autofocus placeholder="Name shown in the dashboard, Claude session title, or session id" />
        <datalist id="session-names"><option v-for="n in names" :key="n" :value="n" /></datalist>
      </label>
      <label>Working folder
        <input v-model="resumeCwd" class="mono" aria-label="Working folder" :placeholder="match?.cwd ?? defaultCwd" />
      </label>
    </div>
    <textarea v-model="resumePrompt" rows="2" placeholder="Message to send (optional; defaults to “Continue where you left off.”)" aria-label="Message" @keydown.ctrl.enter="resume" />
    <div class="row">
      <span class="muted hint">
        {{ match ? `Matches "${match.name ?? match.default_name}" in the dashboard.` : resumeName.trim() ? "Not in the dashboard: Claude will look it up by session title or id in the working folder." : "" }}
      </span>
      <button class="action primary" type="submit" :disabled="busy !== null || !resumeName.trim()">{{ busy === "resume" ? "Resuming…" : "Resume session" }}</button>
    </div>
  </form>
</template>
