<script setup lang="ts">
import type { StatusStyle } from "../api";

defineProps<{ state: string; styles: Record<string, StatusStyle> }>();
</script>

<template>
  <span class="chip" :class="{ pulse: styles[state]?.attention }" :style="{ background: styles[state]?.color ?? '#98A2B3' }">
    <span v-if="styles[state]?.attention" aria-hidden="true">!</span>
    {{ styles[state]?.label ?? state }}
  </span>
</template>
