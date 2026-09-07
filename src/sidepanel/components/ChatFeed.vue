<script setup lang="ts">
import AssistantText from './AssistantText.vue';
import { ref } from 'vue';
import { assistantProse, type ChatMessage } from '../chat-message';
import { visualizeControls } from '../../security/untrusted-text';
defineProps<{ messages: readonly ChatMessage[] }>();
const copied = ref<number | null>(null);
const copyError = ref<number | null>(null);
const copyReply = async (message: ChatMessage, index: number): Promise<void> => {
  try { await navigator.clipboard.writeText(assistantProse(message.text)); copied.value = index; copyError.value = null; }
  catch { copyError.value = index; }
};
const statuses = { approval: '等待确认', running: '执行中', review: '等待审阅', release: '等待发送结果', done: '已完成', failed: '执行失败', cancelled: '已停止' };
const operation = (message: ChatMessage): string => {
  const call = message.tool;
  return visualizeControls(!call ? message.text : call.tool === 'bash' ? call.args.cmd : call.tool === 'fetch' ? call.args.url : call.args.path);
};
</script>

<template>
  <section class="chat-feed" aria-label="对话记录">
    <article v-for="(message, index) in messages" :key="index" class="chat-message" :class="`message-${message.role}`" :data-role="message.role">
      <template v-if="message.role === 'tool'">
        <details class="tool-details"><summary class="tool-card-header"><span class="tool-icon" aria-hidden="true">&gt;_</span><strong>{{ message.tool?.tool === 'edit_file' ? '编辑文件' : message.tool?.tool === 'write_file' ? '写入文件' : message.tool?.tool === 'read_file' ? '读取文件' : message.tool?.tool === 'bash' ? '执行命令' : '请求资源' }}</strong><code class="tool-target">{{ operation(message) }}</code><span class="tool-status" :data-status="message.status">{{ message.status ? statuses[message.status] : '准备中' }}</span><span class="tool-expand" aria-hidden="true">⌄</span></summary>
        <section v-if="message.result" class="tool-result"><small>执行结果 · exit {{ message.result.exitCode ?? 'n/a' }} · {{ message.result.durationMs }} ms</small><pre class="tool-command">{{ visualizeControls(message.result.text) || '（无输出）' }}</pre><p v-if="message.result.truncated">工具返回的输出已截断。</p></section><small class="tool-name">{{ message.tool?.tool }}</small><pre class="tool-command">{{ operation(message) }}</pre>
        <details v-if="message.tool?.tool === 'edit_file'"><summary>查看替换内容</summary><p>原文</p><pre class="tool-command">{{ visualizeControls(message.tool.args.old_string) }}</pre><p>替换为{{ message.tool.args.replace_all ? '（全部匹配）' : '（唯一匹配）' }}</p><pre class="tool-command">{{ visualizeControls(message.tool.args.new_string) }}</pre></details><details v-if="message.tool?.tool === 'write_file'"><summary>查看文件内容</summary><pre class="tool-command">{{ visualizeControls(message.tool.args.content) }}</pre></details></details>
      </template>
      <template v-else>
        <span v-if="message.role !== 'system'" class="message-author">{{ message.role === 'user' ? '你' : 'kcode' }}</span>
        <AssistantText v-if="message.role === 'assistant'" :text="assistantProse(message.text) || '正在整理工具请求…'" />
        <p v-else class="message-body">{{ message.text }}</p><div v-if="message.images?.length" class="message-images"><img v-for="image in message.images" :key="image.dataUrl" :src="image.dataUrl" :alt="image.name"></div>
        <button v-if="message.role === 'assistant' && assistantProse(message.text)" class="copy-reply" type="button" @click="copyReply(message, index)">{{ copyError === index ? '复制失败，点击重试' : copied === index ? '已复制' : '复制回复' }}</button>
      </template>
    </article>
  </section>
</template>
