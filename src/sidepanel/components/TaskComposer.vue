<script setup lang="ts">
import { ref } from 'vue';
import { MAX_IMAGES, MAX_IMAGE_BYTES, type ImageAttachment } from '../../types/attachments';
const props = defineProps<{ disabled: boolean; hint: string | null; busy?: boolean; hasMessages?: boolean }>();
const emit = defineEmits<{ submit: [prompt: string, images?: ImageAttachment[]]; cancel: [] }>();
const prompt = ref('');
const images = ref<ImageAttachment[]>([]);
const attachmentError = ref('');
const loadingImages = ref(false);
const imagePicker = ref<HTMLInputElement>();
const addImages = async (files: File[]): Promise<void> => {
  if (loadingImages.value) return;
  loadingImages.value = true; attachmentError.value = '';
  try {
    for (const file of files) {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { attachmentError.value = '仅支持 PNG、JPEG、WebP 图片。'; continue; }
      if (images.value.length >= MAX_IMAGES) { attachmentError.value = '最多添加 3 张图片。'; break; }
      if (file.size === 0) { attachmentError.value = '图片文件为空。'; continue; }
      if (file.size > MAX_IMAGE_BYTES) { attachmentError.value = '每张图片不能超过 2 MiB。'; continue; }
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
      images.value.push({ name: file.name.slice(0, 128) || 'image.png', dataUrl });
    }
  } catch { attachmentError.value = '图片读取失败，请重试。'; }
  finally { loadingImages.value = false; }
};
const paste = (event: ClipboardEvent): void => {
  const files = [...(event.clipboardData?.items ?? [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file);
  if (files.length) { event.preventDefault(); void addImages(files); }
};
const pick = (event: Event): void => { const input = event.target as HTMLInputElement; void addImages([...(input.files ?? [])]); input.value = ''; };

const submit = (): void => {
  if (props.disabled || loadingImages.value || (!prompt.value.trim() && !images.value.length)) return;
  if (images.value.length) emit('submit', prompt.value.trim() || '请分析这些图片。', [...images.value]);
  else emit('submit', prompt.value.trim());
  images.value = []; attachmentError.value = '';
  prompt.value = '';
};
const onKey = (event: KeyboardEvent): void => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
};
</script>

<template>
  <form class="task-composer" @submit.prevent="submit">
    <label for="task-prompt">任务</label>
    <div class="composer-box" @paste="paste"><div v-if="images.length" class="attachment-preview"><div v-for="(image, index) in images" :key="image.dataUrl"><img :src="image.dataUrl" :alt="image.name"><button type="button" :aria-label="'移除图片 ' + (index + 1)" @click="images.splice(index, 1)">×</button></div></div><small v-if="images.length" class="attachment-note">图片会发送给当前聊天页面，不进行文字脱敏。</small><small v-if="attachmentError" role="alert" class="attachment-error">{{ attachmentError }}</small>
      <textarea id="task-prompt" v-model="prompt" name="task-prompt" rows="3" autocomplete="off"
        :placeholder="busy ? '可以先写下下一步，当前任务结束后发送…' : hasMessages ? '继续描述下一步想做的事…' : '描述任务，交给 kcode 执行…'" @keydown="onKey" />
      <div class="composer-actions"><input ref="imagePicker" class="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" multiple aria-label="选择图片" @change="pick"><button type="button" class="attach-button" aria-label="添加图片" :disabled="loadingImages" @click="imagePicker?.click()">＋</button><small>Enter 发送 · Shift + Enter 换行</small>
        <button v-if="busy" class="stop-button" type="button" @click="emit('cancel')">■ 一键停止</button>
        <button v-else type="submit" :disabled="disabled || loadingImages || (!prompt.trim() && !images.length)" aria-label="开始任务" title="发送任务">↑ <span>发送</span></button>
      </div>
    </div>
    <small v-if="hint && !hasMessages && !busy" class="task-composer-hint" role="status">{{ hint }}</small>
  </form>
</template>
