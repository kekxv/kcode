<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import '@xterm/xterm/css/xterm.css';
import type { TerminalManager } from '../terminal-manager';

const props = defineProps<{ chunks?: readonly string[]; theme?: 'light' | 'dark'; interactive?: boolean }>();
const emit = defineEmits<{ input: [data: string]; ready: [] }>();
const host = ref<HTMLElement>();
let terminal: TerminalManager | null = null;
let disposed = false;
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
    if (disposed || !host.value) return;
    terminal = new TerminalManager(undefined, props.interactive);
    terminal.setTheme(props.theme ?? 'dark');
    terminal.onInput(data => emit('input', data));
    terminal.mount(host.value);
    writeNewChunks();
    emit('ready');
  }
});
watch(() => props.theme, theme => terminal?.setTheme(theme ?? 'dark'));
watch(() => props.chunks, writeNewChunks, { deep: true });
const focusTerminal = () => terminal?.focus();
defineExpose({ size: () => terminal?.size() ?? { cols: 80, rows: 24 }, writeLocal: (text: string) => terminal?.writeLocal(text), focus: () => terminal?.focus() });
onBeforeUnmount(() => { disposed = true; terminal?.dispose(); });
</script>

<template><section ref="host" class="terminal-pane" :data-theme="theme ?? 'dark'" aria-label="安全终端" @click="focusTerminal" /></template>
