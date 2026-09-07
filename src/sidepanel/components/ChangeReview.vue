<script setup lang="ts">
import type { JournalSummary } from '../../worker/p9/mutation-journal';
defineProps<{ summary: JournalSummary }>();
const emit = defineEmits<{ accept: []; rollback: [] }>();
</script>
<template>
  <section class="action-card" aria-label="变更审阅">
    <h3>审阅工作区变更</h3>
    <p>事务：{{ summary.transactionId }}；状态：{{ summary.state }}；写入：{{ summary.writtenBytes }} bytes</p>
    <ul><li v-for="entry in summary.entries" :key="`${entry.operation}:${entry.path}`">{{ entry.operation }} {{ entry.path }}（{{ entry.originalBytes }} → {{ entry.resultingBytes }} bytes）</li></ul>
    <button @click="emit('accept')">接受变更</button><button @click="emit('rollback')">回滚变更</button>
  </section>
</template>
