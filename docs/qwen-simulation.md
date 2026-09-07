# Qwen 模拟交互测试

运行整个 Qwen 回归测试组：

```sh
npm run test:qwen
```

只运行跨模块模拟交互：

```sh
npm run test:run -- tests/simulation/qwen-interaction.test.ts
```

模拟测试不需要 Qwen 账号、网络、Chrome 或 VM 镜像。使用 jsdom 和虚拟时钟，90 秒超时场景也无需实际等待 90 秒。

## 测试链路

模拟 Qwen 页面 DOM → **QwenAdapter → ContentController → PortRouter → TabClient → AgentOrchestrator → 工具解析器 → ToolDispatcher** → 内存 VM → 工具结果经原链路发送到模拟页面 → 下一轮回复。

加粗的组件及工具解析、调度均使用生产实现。Chrome Port 传输由同进程回调模拟；通过路由器公开的集成测试入口注册端口，未覆盖 Chrome 的真实 onConnect 身份认证。VM 使用事务内存存储，支持写入、读取、提交、回滚，以及固定目录列表响应；不会解释或执行模型生成的 Shell 命令。

`test:qwen` 还运行已有侧栏测试，检查用户/AI/工具消息分类、授权、结果发布、终止提示和重新开始任务。跨模块模拟本身没有渲染侧栏 UI。

## 场景

- 四轮任务：目录检查 → 写 HTML → 读取验证 → 完成摘要。
- 流式文本多次替换，中间态不触发工具执行。
- Qwen 重建聊天区域、重写同源会话 URL，克隆的历史消息不会重复执行。
- 停止按钮移除、隐藏、改变标签三种完成方式。
- 缺少 `>` 的原生 XML；编号标签内包含未转义 HTML 属性引号的 JSON。
- 说明文字后接 `<tool_call_bash>` 和 `arg_key/arg_value` 参数，保留 `workspace: read`，执行后继续下一轮。
- `<tool_call id="call_1">` 包裹 JSON，支持普通结束标签和模型生成的 `</tool_call id="call_1">`；标签与 JSON 的 ID 必须一致。
- 未识别、截断或属性不合法的工具标签走格式修正流程，不会作为最终答案误报任务完成。
- 无效格式反馈到模拟输入框，模型修正后继续任务。
- 连续无效格式：两次修正后明确失败，不执行工具。
- 页面持续生成：90 秒超时，不释放未完成的工具调用。
- 用户取消：忽略晚到输出，不产生迟到的超时。
- 拒绝授权：不写入文件，也不继续请求模型。

每个场景结束后清理 DOM 监听、端口客户端和时钟，断言没有残留定时器。成功场景继续推进 90 秒，确认不会出现延迟的 CONTENT_TIMEOUT。

## 添加一种 Qwen 回复

在 `tests/simulation/qwen-interaction.test.ts` 中给 `setup` 传入每轮的页面变化：

```ts
const s = setup([
  {
    snapshots: ['<tool_call>', '<tool_call>{"id":"read_1","tool":"read_file","args":{"path":"index.html"}}</tool_call>'],
    remount: true,
    stop: 'hidden',
  },
  { snapshots: ['验证完成。'] },
]);
s.files.set('index.html', '<h1>Hello</h1>');
void s.start();
expect((await s.finish()).state).toBe('completed');
```

`snapshots` 是每 100ms 替换一次的完整回复快照，不是增量片段。`remount` 重建整个 main 区域并保留历史；`stop` 可选 `remove`（默认）、`hidden`、`relabel`、`stall`（一直生成）。脚本用尽却又收到请求会记录在 `unexpectedPrompts`，用于发现意外的额外交互。

可检查 `prompts`、`events`、`states`、`recoveries`、`approvals`、`vm` 调用及最终 `files`。脚本回复是预先定义的，不证明真实模型会遵守提示词；真实 Qwen 改版和真实 VM 行为仍需要单独验证。
