<script setup lang="ts">
defineProps<{ summary: string }>();
const emit = defineEmits<{ reviewChanges: []; cancel: [] }>();
</script>
<template><section aria-label="变更审阅"><pre>{{ summary }}</pre><button @click="emit('reviewChanges')">审阅变更</button><button @click="emit('cancel')">取消</button></section></template>
