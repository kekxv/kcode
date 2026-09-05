<script setup lang="ts">
import { computed, ref } from 'vue';
const props = defineProps<{ auto: boolean; network: boolean }>();
const emit = defineEmits<{ accept: []; cancel: [] }>();
const checks = ref<boolean[]>([]);
const warnings = computed(() => [
  ...(props.auto ? [
    'AI 可以读取、修改和删除所选目录',
    '仓库和软件包安装脚本可以执行',
    '工具结果会发送到 DeepSeek',
    '操作可能在自动日志提交后造成不可恢复的数据丢失',
  ] : []),
  ...(props.network ? [
    '启用网络后，客体命令可上传可读工作区内容，且不经过结果 DLP',
    'WISP 中继可观察目标元数据和明文协议',
  ] : []),
]);
const complete = computed(() => warnings.value.length > 0 && warnings.value.every((_warning, index) => checks.value[index] === true));
</script>

<template>
  <section class="risk-dialog" role="dialog" aria-modal="true" aria-label="高风险能力确认">
    <h2>高风险能力确认</h2>
    <label v-for="(warning, index) in warnings" :key="warning"><input v-model="checks[index]" type="checkbox">{{ warning }}</label>
    <button :disabled="!complete" @click="emit('accept')">启用 Auto</button>
    <button @click="emit('cancel')">取消</button>
  </section>
</template>
