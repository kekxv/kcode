<script setup lang="ts">
defineProps<{ directory: string; vm: string; webpage: string; execution: string; network: string; capability: string; journal: string; release: string }>();
</script>

<template>
  <section class="status-bar" aria-label="运行状态">
    <span>目录：{{ directory }}</span><span>VM：{{ vm }}</span><span>网页：{{ webpage }}</span>
    <span>执行：{{ execution }}</span><span>网络：{{ network }}</span><span>能力：{{ capability }}</span>
    <span>日志：{{ journal }}</span><span>发布：{{ release }}</span>
  </section>
</template>
