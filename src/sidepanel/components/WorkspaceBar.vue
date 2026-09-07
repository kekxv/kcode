<script setup lang="ts">
import { ref } from 'vue';
const props = defineProps<{ folder: string | null; permission: string; provider: string | null; refreshing: boolean; connectionError: string | null; refreshNote: string; mode: string; locked: boolean }>();
const emit = defineEmits<{ choose: []; refresh: []; mode: [value: string]; settings: [] }>();
const menu = ref(false);
const modes = [{ value: 'confirm-each', label: '手动', detail: '工具、变更和结果逐步确认' }, { value: 'auto-write', label: '自动写入', detail: '文件自动处理，Shell 仍需确认' }, { value: 'auto', label: '全自动', detail: '自动执行工具并发送脱敏结果' }];
const select = (value: string) => { menu.value = false; emit('mode', value); };
</script>
<template>
  <div class="workspace-bar">
    <div class="workspace-row"><button class="project-picker" :disabled="locked" @click="emit('choose')" :title="folder || '选择本地项目文件夹'" aria-label="选择工作目录"><span class="folder-icon" aria-hidden="true">▱</span><span><strong>{{ folder || '选择项目文件夹' }}</strong><small class="visually-hidden">{{ folder ? permission === 'granted' ? '已连接 · /work' : '需要重新授权' : '连接本地目录后开始工作' }}</small></span><span class="picker-chevron">⌄</span></button>      <div class="mode-control" @keydown.esc="menu = false" @focusout="!($event.currentTarget as HTMLElement).contains($event.relatedTarget as Node) && (menu = false)">
        <button class="mode-trigger" aria-label="执行模式" aria-haspopup="listbox" :aria-expanded="menu" :disabled="locked || !folder" @click="menu = !menu">{{ modes.find(item => item.value === mode)?.label }} <span>⌄</span></button>
        <div v-if="menu" class="mode-menu" role="listbox" aria-label="选择执行模式"><button v-for="item in modes" :key="item.value" role="option" :aria-selected="item.value === mode" @click="select(item.value)"><span><strong>{{ item.label }}</strong><small>{{ item.detail }}</small></span><span v-if="item.value === mode">✓</span></button></div>
      </div><button class="icon-button" aria-label="会话设置" title="设置" @click="emit('settings')">⚙</button></div>
    <div class="connection-row"><span class="connection-dot" :class="{ connected: provider, error: connectionError }"></span><span class="connection-label">{{ refreshing ? '检查连接中…' : connectionError ? '连接检查失败' : provider || '等待聊天页面连接' }}</span><button class="refresh-button" :class="{ spinning: refreshing }" :disabled="refreshing" aria-label="刷新聊天连接" :title="connectionError || refreshNote || '重新检查聊天连接'" @click="emit('refresh')">↻</button><small class="refresh-note visually-hidden" aria-live="polite">{{ !refreshing ? refreshNote : '' }}</small>
      <slot />
    </div>
  </div>
</template>
