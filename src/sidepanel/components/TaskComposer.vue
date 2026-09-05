<script setup lang="ts">
import { ref } from 'vue';
const props = defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ submit: [prompt: string]; cancel: [] }>();
const prompt = ref('');
const submit = (): void => { if (!props.disabled && prompt.value.trim()) emit('submit', prompt.value); };
</script>

<template>
  <form class="task-composer" @submit.prevent="submit">
    <label>任务<textarea v-model="prompt" rows="4" /></label>
    <button type="submit" :disabled="disabled || !prompt.trim()">开始任务</button>
    <button type="button" @click="emit('cancel')">一键停止</button>
  </form>
</template>
