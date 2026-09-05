<script setup lang="ts">
defineProps<{ messages: readonly string[] }>();
</script>

<template>
  <section class="chat-feed" aria-label="对话记录">
    <p v-for="(message, index) in messages" :key="index">{{ message }}</p>
  </section>
</template>
