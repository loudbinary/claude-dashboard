<script setup lang="ts">
import DOMPurify from "dompurify";
import { marked } from "marked";
import { computed } from "vue";

const props = defineProps<{ text: string }>();

// Links open in a new tab and never hand the dashboard's window to the target page.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
});

// Claude's output is treated as untrusted: rendered to HTML, then sanitized before it reaches the page.
const html = computed(() =>
  DOMPurify.sanitize(marked.parse(props.text, { gfm: true, breaks: true, async: false }) as string,
    { FORBID_TAGS: ["img", "style", "form", "input", "button"] }));
</script>

<template>
  <div class="md" v-html="html" />
</template>
