<script setup lang="ts">
import { computed, ref } from 'vue';
import type { WorkRecord } from '../work-history';
const props = defineProps<{ records: readonly WorkRecord[]; selectedId: string; locked: boolean }>();
const emit = defineEmits<{ select: [id: string] }>();
const open = ref(false);
const query = ref('');
const filtered = computed(() => props.records.filter(record => `${record.task} ${record.provider} ${record.outcome}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())));
const selected = computed(() => props.records.find(record => record.id === props.selectedId));
const status = { completed: '已完成', failed: '失败', cancelled: '已停止' };
const choose = (id: string) => { emit('select', id); open.value = false; };
</script>
<template>
  <section class="history-browser" @keydown.esc="open = false">
    <div class="history-toolbar">
      <button class="history-trigger" :disabled="locked" :aria-expanded="open" @click="open = !open"><span aria-hidden="true">◷</span><span>历史任务</span><small>{{ records.length }}</small><span class="history-current">{{ selected?.task || '当前对话' }}</span><span aria-hidden="true">⌄</span></button>
      <button class="history-new" aria-label="新对话" title="新对话" :disabled="locked" @click="choose('')"><span aria-hidden="true">＋</span></button>
    </div>
    <section v-if="open" class="history-list-panel" aria-label="历史任务列表">
      <header><strong>任务记录</strong><button aria-label="关闭历史任务" @click="open = false">×</button></header>
      <input v-model="query" type="search" aria-label="搜索历史任务" placeholder="搜索任务、结果或模型…">
      <div class="history-list">
        <button v-for="record in filtered" :key="record.id" class="history-item" :class="{ selected: selectedId === record.id }" :disabled="locked" :aria-pressed="selectedId === record.id" @click="choose(record.id)">
          <span class="history-item-title">{{ record.task }}</span>
          <span class="history-item-meta"><span>{{ record.provider }}</span><time>{{ new Date(record.createdAt).toLocaleString() }}</time></span>
          <span class="history-item-meta"><span :data-status="record.status">{{ status[record.status] }}</span><span>{{ record.messages ? `${record.messages.length} 条消息` : '旧版摘要' }}</span></span>
        </button>
        <p v-if="!filtered.length" class="history-empty">{{ query ? '没有匹配的任务' : '暂无历史任务，启用工作记录后将在这里保存。' }}</p>
      </div>
    </section>
  </section>
</template>
