<script setup lang="ts">
defineProps<{ result: string }>();
const emit = defineEmits<{ releaseResult: []; cancel: [] }>();
</script>
<template><section aria-label="结果发布"><pre>{{ result }}</pre><button @click="emit('releaseResult')">发布结果</button><button @click="emit('cancel')">取消</button></section></template>
