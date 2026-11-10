<script setup lang="ts">
import type { StatusStyle } from "../api";

defineProps<{ state: string; styles: Record<string, StatusStyle>; seen?: boolean }>();
</script>

<template>
  <span class="chip" :class="{ pulse: styles[state]?.attention && !seen, seen: styles[state]?.attention && seen }"
        :style="{ background: styles[state]?.color ?? '#98A2B3' }" :title="styles[state]?.attention && seen ? 'Seen' : undefined">
    <span v-if="styles[state]?.attention" aria-hidden="true">{{ seen ? "✓" : "!" }}</span>
    {{ styles[state]?.label ?? state }}<span v-if="styles[state]?.attention && seen" class="sr"> (seen)</span>
  </span>
</template>
