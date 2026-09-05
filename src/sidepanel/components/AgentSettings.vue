<script setup lang="ts">
defineProps<{ modelValue: string; error: string | null }>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; save: []; clear: [] }>();
const update = (event: Event): void => emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
</script>

<template>
  <section class="agent-settings" aria-label="Agent 指令设置">
    <label>自定义 Agent 指令<textarea :value="modelValue" rows="3" maxlength="16384" @input="update" /></label>
    <button type="button" @click="emit('save')">保存指令</button>
    <button type="button" @click="emit('clear')">清除指令</button>
    <small>随每个新任务发送给所选网页 AI；不会改变 kcode 的权限、路径保护或审批规则。</small>
    <small v-if="error" role="alert">{{ error }}</small>
  </section>
</template>
