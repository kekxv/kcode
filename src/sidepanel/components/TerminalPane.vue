<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { TerminalManager } from '../terminal-manager';

const props = defineProps<{ chunks?: readonly string[] }>();
const host = ref<HTMLElement>();
let terminal: TerminalManager | null = null;
let deliveredChunks = 0;
const writeNewChunks = (): void => {
  const chunks = props.chunks ?? [];
  if (chunks.length < deliveredChunks) deliveredChunks = 0;
  if (!terminal) return;
  for (const chunk of chunks.slice(deliveredChunks)) terminal.write(chunk);
  deliveredChunks = chunks.length;
};
onMounted(async () => {
  if (host.value && typeof window.matchMedia === 'function') {
    const { TerminalManager } = await import('../terminal-manager');
    terminal = new TerminalManager();
    terminal.mount(host.value);
    writeNewChunks();
  }
});
watch(() => props.chunks, writeNewChunks, { deep: true });
onBeforeUnmount(() => terminal?.dispose());
</script>

<template><section ref="host" class="terminal-pane" aria-label="安全终端" /></template>
