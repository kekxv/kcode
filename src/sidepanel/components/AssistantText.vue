<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ text: string }>();
// Render a small, safe Markdown subset as Vue text nodes, never model HTML.
const lines = computed(() => props.text.split('\n'));
const inline = (line: string) => line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map(text => ({
  kind: text.startsWith('`') && text.endsWith('`') ? 'code' : text.startsWith('**') && text.endsWith('**') ? 'strong' : 'span',
  text: text.startsWith('`') && text.endsWith('`') ? text.slice(1, -1) : text.startsWith('**') && text.endsWith('**') ? text.slice(2, -2) : text,
}));
</script>
<template>
  <div class="message-body assistant-text">
    <div v-for="(line, index) in lines" :key="index" class="reply-line" :class="{ 'reply-heading': /^#{1,6} /.test(line), 'reply-list': /^(?:[-*•] |\d+\. )/.test(line), 'reply-space': !line }">
      <component :is="part.kind" v-for="(part, partIndex) in inline(line.replace(/^#{1,6} /, ''))" :key="partIndex">{{ part.text }}</component>
    </div>
  </div>
</template>
