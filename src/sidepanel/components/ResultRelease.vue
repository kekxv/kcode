<script setup lang="ts">
import type { GuardedResult } from '../../types/tools';
defineProps<{ result: GuardedResult }>();
const emit = defineEmits<{ release: []; cancel: [] }>();
</script>
<template>
  <section aria-label="结果发布">
    <p>将发送 {{ result.utf8Bytes }} bytes<span v-if="result.truncated">（已截断）</span></p>
    <ul><li v-for="finding in result.findings" :key="finding.kind">{{ finding.kind }}：{{ finding.count }}</li></ul>
    <pre>{{ result.redactedText }}</pre>
    <button @click="emit('release')">发送脱敏结果</button><button @click="emit('cancel')">不发送并停止</button>
  </section>
</template>
