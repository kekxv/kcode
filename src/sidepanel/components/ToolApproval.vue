<script setup lang="ts">
import { computed } from 'vue';
import { visualizeControls } from '../../security/untrusted-text';
const props = defineProps<{ command: string }>();
const emit = defineEmits<{ approveTool: []; reject: [] }>();
const visibleCommand = computed(() => visualizeControls(props.command));
</script>
<template><section aria-label="工具批准"><pre>{{ visibleCommand }}</pre><button @click="emit('approveTool')">批准工具</button><button @click="emit('reject')">拒绝</button></section></template>
