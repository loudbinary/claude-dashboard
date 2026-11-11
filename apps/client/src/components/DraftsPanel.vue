<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { api, type DraftsInfo, type Session } from "../api";

const props = defineProps<{ session: Session }>();
const emit = defineEmits<{ toast: [text: string, error?: boolean] }>();

const info = ref<DraftsInfo | null>(null);
// Local edits survive reloads: a row only takes its server text the first time it is seen.
const text = reactive<Record<number, string>>({});
const checked = reactive<Record<number, boolean>>({});
const summaryText = ref("");
const summaryTouched = ref(false);
const includeSummary = ref(true);
const posting = ref(false);

async function load() {
  try { info.value = await api.drafts(props.session.id); } catch { info.value = null; return; }
  for (const d of info.value.drafts) {
    if (!(d.idx in text)) { text[d.idx] = d.comment; checked[d.idx] = true; }
  }
  if (!summaryTouched.value) summaryText.value = info.value.summary ?? "";
}
watch(() => props.session.id, () => { info.value = null; summaryTouched.value = false; load(); }, { immediate: true });
watch(() => props.session.updated_at, load);

const drafts = computed(() => info.value?.drafts ?? []);
const summaryPosted = computed(() => !!info.value?.summary_thread_id);
const selected = computed(() => drafts.value.filter((d) => d.status !== "posted" && checked[d.idx]));
const postCount = computed(() => selected.value.length + (includeSummary.value && !summaryPosted.value && summaryText.value.trim() ? 1 : 0));
// A review that has finished but produced no block gets a note instead of an empty panel.
const finished = computed(() => ["waiting_reply", "done", "failed"].includes(props.session.state));
const noDrafts = computed(() => !!info.value?.pr_url && !drafts.value.length && !info.value.summary && finished.value);

const threadUrl = (id: string) => `${info.value!.pr_url}?discussionId=${encodeURIComponent(id)}`;

async function post() {
  const n = postCount.value;
  if (!n || posting.value) return;
  if (!confirm(`Post ${n} comment${n === 1 ? "" : "s"} to the pull request?\n\n${info.value?.pr_url}\n\nThey are posted under your account and cannot be recalled from here.`)) return;
  posting.value = true;
  try {
    const out = await api.postDrafts(props.session.id, selected.value.map((d) => ({ idx: d.idx, comment: text[d.idx]! })), includeSummary.value && !summaryPosted.value, summaryText.value);
    const problems = out.failed.length + (out.summary && "error" in out.summary ? 1 : 0);
    const ok = out.posted.length + (out.summary && "thread_id" in out.summary && includeSummary.value && !summaryPosted.value ? 1 : 0);
    emit("toast", problems ? `Posted ${ok}, ${problems} failed. Failed ones stay here so you can retry.` : `Posted ${ok} comment${ok === 1 ? "" : "s"}`, problems > 0);
  } catch (err) { emit("toast", (err as Error).message, true); }
  finally { posting.value = false; await load(); }
}
</script>

<template>
  <section v-if="drafts.length || info?.summary" class="drafts">
    <h3>Draft comments ({{ drafts.length }})</h3>
    <div class="drafts-head">
      <span v-if="info?.verdict" class="verdict" :class="info.verdict === 'clean' ? 'clean' : 'changes'">Verdict: {{ info.verdict }}</span>
      <a v-if="info?.pr_url" :href="info.pr_url" target="_blank" rel="noopener">Pull request</a>
      <span class="muted">Nothing is posted until you click Post selected.</span>
    </div>

    <div v-if="info?.summary" class="draft summary">
      <label class="pick">
        <input v-if="!summaryPosted" v-model="includeSummary" type="checkbox" />
        <span>Include summary</span>
        <a v-if="summaryPosted" :href="threadUrl(info.summary_thread_id!)" target="_blank" rel="noopener">posted</a>
      </label>
      <textarea v-model="summaryText" rows="3" aria-label="Summary comment" :disabled="summaryPosted" @input="summaryTouched = true" />
    </div>

    <div v-for="d in drafts" :key="d.idx" class="draft" :class="d.status">
      <label class="pick">
        <input v-model="checked[d.idx]" type="checkbox" :disabled="d.status === 'posted'" :aria-label="`Post draft ${d.idx}`" />
        <span class="mono">{{ d.file }}:{{ d.line }}{{ d.end_line ? `-${d.end_line}` : "" }}</span>
        <span class="sev" :class="d.severity">{{ d.severity }}</span>
        <a v-if="d.status === 'posted' && d.thread_id" :href="threadUrl(d.thread_id)" target="_blank" rel="noopener">posted</a>
        <span v-else-if="d.status === 'failed'" class="err" :title="d.error ?? ''">failed: {{ d.error }}</span>
      </label>
      <textarea v-model="text[d.idx]" rows="3" :aria-label="`Draft ${d.idx} comment`" :disabled="d.status === 'posted'" />
    </div>

    <button class="action" :disabled="posting || !postCount" @click="post">{{ posting ? "Posting…" : `Post selected (${postCount})` }}</button>
  </section>
  <section v-else-if="noDrafts" class="drafts">
    <h3>Draft comments</h3>
    <p class="muted">No structured drafts found in this review's final message.</p>
  </section>
</template>
