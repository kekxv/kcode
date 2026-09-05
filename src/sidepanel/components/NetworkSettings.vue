<script setup lang="ts">
defineProps<{ modelValue: string; savedUrl: string | null; error: string | null }>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; save: []; clear: [] }>();
const update = (event: Event): void => emit('update:modelValue', (event.target as HTMLInputElement).value);
</script>

<template>
  <section class="network-settings" aria-label="WISP 中继设置">
    <label>WISP relay URL<input :value="modelValue" type="url" placeholder="wss://relay.example/path" autocomplete="off" @input="update"></label>
    <button type="button" @click="emit('save')">保存中继</button>
    <button type="button" @click="emit('clear')">清除中继</button>
    <small v-if="savedUrl">已保存：{{ savedUrl }}</small>
    <small v-if="error" role="alert">{{ error }}</small>
  </section>
</template>
