<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { visualizeControls } from '../../security/untrusted-text';
import TerminalPane from './TerminalPane.vue';
const props = defineProps<{ chunks: readonly string[]; theme?: 'light' | 'dark'; running: boolean; blocked: boolean; folder: string | null; status: string }>();
const emit = defineEmits<{ execute: [command: string, size?: { cols: number; rows: number }]; stdin: [data: string]; stop: []; clear: []; toggleTheme: []; close: [] }>();
const pane = ref<InstanceType<typeof TerminalPane>>();
let command = ''; let cursor = 0; const history: string[] = []; let historyIndex = 0;
const prompt = () => '\x1b[32m❯\x1b[0m \x1b[36m' + visualizeControls(props.folder ?? '/work') + '\x1b[0m ';
const draw = () => {
  const chars = Array.from(command); const tail = chars.slice(cursor).join('');
  const width = Array.from(tail).reduce((size, char) => size + (char.charCodeAt(0) > 255 ? 2 : 1), 0);
  pane.value?.writeLocal('\r\x1b[2K' + prompt() + command.replaceAll('\n', '↵') + (width ? '\x1b[' + width + 'D' : ''));
};
const ready = () => { if (!props.running) draw(); };
const input = (data: string) => {
  if (data === '\x03') { if (props.running) emit('stdin', data); else { command = ''; cursor = 0; pane.value?.writeLocal('^C\r\n'); draw(); } return; }
  if (props.blocked || !props.folder) return;
  if (props.running) { emit('stdin', data); return; }
  const chars = Array.from(command);
  if (data === '\r') {
    if (!command.trim()) { pane.value?.writeLocal('\r\n'); draw(); return; }
    const value = command; history.push(value); if (history.length > 100) history.shift(); historyIndex = history.length;
    command = ''; cursor = 0;
    pane.value?.writeLocal('\r\x1b[2K');
    emit('execute', value, pane.value?.size?.()); return;
  }
  if (data === '\x1b[A' || data === '\x1b[B') {
    historyIndex = Math.max(0, Math.min(history.length, historyIndex + (data.endsWith('A') ? -1 : 1)));
    command = history[historyIndex] ?? ''; cursor = Array.from(command).length;
  } else if (data === '\x7f') { if (cursor) { chars.splice(--cursor, 1); command = chars.join(''); } }
  else if (data === '\x1b[D') cursor = Math.max(0, cursor - 1);
  else if (data === '\x1b[C') cursor = Math.min(chars.length, cursor + 1);
  else if (data === '\x01' || data === '\x1b[H') cursor = 0;
  else if (data === '\x05' || data === '\x1b[F') cursor = chars.length;
  else if (data === '\x1b[3~') { chars.splice(cursor, 1); command = chars.join(''); }
  else if (data === '\x15') { command = chars.slice(cursor).join(''); cursor = 0; }
  else if (data === '\x0c') pane.value?.writeLocal('\x1b[2J\x1b[H');
  else if (!data.startsWith('\x1b')) {
    // Multiline paste is staged for an explicit Enter, never auto-executed.
    const inserted = visualizeControls(data.replaceAll('\r', '\n'));
    if (command.length + inserted.length > 32768) return;
    chars.splice(cursor, 0, ...Array.from(inserted)); command = chars.join(''); cursor += Array.from(inserted).length;
  }
  draw();
};
watch(() => props.running, async running => { await nextTick(); if (!running) draw(); });
watch(() => props.folder, () => { if (!props.running) draw(); });
const clear = () => { emit('clear'); pane.value?.writeLocal('\x1b[2J\x1b[H'); if (!props.running) draw(); };
</script>
<template>
  <section class="shell-console terminal-dock" aria-label="VM Shell">
    <header><strong>Terminal 1</strong><button class="icon-button" aria-label="切换终端主题" @click="emit('toggleTheme')">{{ theme === 'light' ? '☾' : '☀' }}</button><button class="icon-button" :disabled="running" @click="clear">清屏</button><button v-if="running" class="icon-button" @click="emit('stop')">停止</button><button class="icon-button" aria-label="收起终端" @click="emit('close')">−</button></header>
    <TerminalPane ref="pane" interactive :chunks="chunks" :theme="theme" @input="input" @ready="ready" />
    <small class="shell-status" aria-live="polite">{{ blocked ? 'Agent 正在使用 VM' : !folder ? '请先选择项目文件夹' : running ? '执行中 · Ctrl+C 停止' : status || '直接输入命令 · ↑ ↓ 历史 · Ctrl+L 清屏' }}</small>
  </section>
</template>
