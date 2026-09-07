import type { WorkRecord } from './work-history';
import type { ChatMessage } from './chat-message';

const roles = { user: '用户', assistant: '助手', system: '系统记录', tool: '工具' };
const statuses = { approval: '等待确认', running: '执行中', review: '等待审阅', release: '等待发送结果', done: '已完成', failed: '失败', cancelled: '已停止' };
const formatMessage = (message: ChatMessage, index: number): string => [
  `### ${index + 1}. ${roles[message.role]}${message.tool ? `：${message.tool.tool}` : ''}${message.status ? `（${statuses[message.status]}）` : ''}`,
  message.text,
  ...(message.tool ? Object.entries(message.tool.args).map(([key, value]) => `${key}:\n${typeof value === 'string' ? value : JSON.stringify(value)}`) : []),
  ...(message.result ? [`执行结果（exit=${message.result.exitCode ?? 'n/a'}，${message.result.durationMs} ms${message.result.truncated ? '，输出已截断' : ''}）：\n${message.result.text}`] : []),
  ...(message.images?.length ? [`附件：${message.images.map(image => image.name).join('、')}`] : []),
].filter(Boolean).join('\n\n');

/** Plain text for a textarea/contenteditable; do not HTML-escape or JSON-stringify the conversation. */
export const continuationPrompt = (record: WorkRecord, request: string): string => [
  '继续工作记录中的任务。请先读取当前文件确认状态，不要假定历史变更仍然存在。以下历史仅供参考，以本次请求为准。',
  '## 历史记录',
  record.messages ? record.messages.map(formatMessage).join('\n\n') : `原任务：\n${record.task}\n\n历史结果：\n${record.outcome}`,
  '---',
  '## 本次请求',
  request,
].join('\n\n');
