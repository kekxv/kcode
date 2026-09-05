<script setup lang="ts">
defineProps<{ workspaceName: string; relayOrigin: string; auto: boolean; network: boolean }>();
const emit = defineEmits<{ stop: [] }>();
</script>
<template>
  <aside v-if="auto || network" class="auto-mode-status" role="alert">
    高风险已启用：{{ workspaceName }}；中继：{{ relayOrigin }}
    <button @click="emit('stop')">停止并撤销</button>
  </aside>
</template>
