<script setup lang="ts">
import { computed } from 'vue';
import { visualizeControls } from '../../security/untrusted-text';
import { authorizationForTool, type ToolCall } from '../../types/tools';
const props = defineProps<{ call: ToolCall; workspaceName: string; network: string }>();
const emit = defineEmits<{ approveTool: []; reject: [] }>();
const visibleOperation = computed(() => visualizeControls(props.call.tool === 'bash' ? props.call.args.cmd : props.call.tool === 'fetch' ? props.call.args.url : props.call.args.path));
const capability = computed(() => authorizationForTool(props.call, 'interactive').capabilities.join(', '));
</script>
<template>
  <section class="action-card" aria-label="工具批准">
    <h3>确认工具调用</h3>
    <p>工具：{{ call.tool }}；ID：{{ call.id }}；能力：{{ capability }}</p>
    <p>目录：{{ workspaceName }}；网络：{{ network }}</p>
    <pre>{{ visibleOperation }}</pre><template v-if="call.tool === 'edit_file'"><p>原文</p><pre>{{ visualizeControls(call.args.old_string) }}</pre><p>替换为{{ call.args.replace_all ? '（全部匹配）' : '（唯一匹配）' }}</p><pre>{{ visualizeControls(call.args.new_string) }}</pre></template>
    <button @click="emit('approveTool')">运行工具</button><button @click="emit('reject')">拒绝</button>
  </section>
</template>
