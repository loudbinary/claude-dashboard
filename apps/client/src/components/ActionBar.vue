<script setup lang="ts">
import { ref, watch } from "vue";
import { api, type Action } from "../api";

const props = defineProps<{ actions: Action[]; defaultCwd: string }>();
const emit = defineEmits<{ toast: [text: string, error?: boolean]; started: [sessionId: string] }>();

const manual = ref("");
const busy = ref<string | null>(null);

// New session form
const open = ref(false);
const prompt = ref("");
const cwd = ref("");
const name = ref("");
watch(() => props.defaultCwd, (v) => { if (!cwd.value) cwd.value = v; }, { immediate: true });

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
    if (!url) throw new Error("The clipboard is empty. Copy a pull request or pipeline URL first.");
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
    prompt.value = ""; name.value = ""; open.value = false;
  } catch (err) {
    emit("toast", (err as Error).message, true);
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <div class="actions">
    <button class="action primary" :aria-expanded="open" @click="open = !open">＋ New session</button>
    <button v-for="a in actions" :key="a.key" class="action" :disabled="busy !== null" @click="run(a)">
      {{ busy === a.key ? "Starting…" : a.label }}
    </button>
    <input v-model="manual" class="url" type="url" placeholder="URL (leave empty to use the clipboard)" aria-label="URL for the action buttons" />
  </div>

  <form v-if="open" class="new-session" @submit.prevent="start">
    <textarea v-model="prompt" rows="3" placeholder="What should Claude do?" aria-label="Prompt" autofocus @keydown.ctrl.enter="start" />
    <div class="row">
      <label>Working folder <input v-model="cwd" class="mono" aria-label="Working folder" /></label>
      <label>Name (optional) <input v-model="name" aria-label="Session name" /></label>
      <button class="action primary" type="submit" :disabled="busy !== null || !prompt.trim()">{{ busy === "new" ? "Starting…" : "Start session" }}</button>
    </div>
  </form>
</template>
