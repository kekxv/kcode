<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { TerminalManager } from '../terminal-manager';

const props = defineProps<{ chunks?: readonly string[] }>();
const host = ref<HTMLElement>();
let terminal: TerminalManager | null = null;
onMounted(async () => {
  // Chrome supports matchMedia; skipping the renderer keeps non-browser test/preview hosts from emulating a terminal unsafely.
  if (host.value && typeof window.matchMedia === 'function' && !navigator.userAgent.includes('jsdom')) {
    const { TerminalManager } = await import('../terminal-manager');
    terminal = new TerminalManager();
    terminal.mount(host.value);
  }
});
watch(() => props.chunks, (chunks) => chunks?.forEach((chunk) => terminal?.write(chunk)), { deep: true });
onBeforeUnmount(() => terminal?.dispose());
</script>

<template><section ref="host" class="terminal-pane" aria-label="安全终端" /></template>
