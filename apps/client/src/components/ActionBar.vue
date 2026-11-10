<script setup lang="ts">
import { ref } from "vue";
import { api, type Action } from "../api";

defineProps<{ actions: Action[] }>();
const emit = defineEmits<{ toast: [text: string, error?: boolean] }>();

const manual = ref("");
const busy = ref<string | null>(null);

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
</script>

<template>
  <div class="actions">
    <button v-for="a in actions" :key="a.key" class="action" :disabled="busy !== null" @click="run(a)">
      {{ busy === a.key ? "Starting…" : a.label }}
    </button>
    <input v-model="manual" class="url" type="url" placeholder="URL (leave empty to use the clipboard)" aria-label="URL for the action buttons" />
  </div>
</template>
