# DeepSeek 页面适配与模拟测试

```sh
npm run test:deepseek
```

`tests/fixtures/deepseek-current-composer.html` 保存用户在 2026-09-06 提供的输入区域结构：无 ID 的 textarea、带尾随空格的 DeepSeek placeholder、无 aria-label 的 div 发送控件、发送箭头 SVG 和 `ds-button--disabled` 禁用类。页面外层、回复区域及生成期间的变化由测试脚本模拟，不是完整在线页面快照。

适配使用 placeholder、设计系统类和已观察到的箭头路径，不依赖生成式哈希类名，也不按按钮排列位置猜测发送按钮。填入提示词后最多等一秒让 UI 解除禁用；有明确发送控件但它仍禁用时不会通过 Enter 绕过。其他仅有 DeepSeek 输入框而无可识别发送控件的布局使用 Enter 回退。

回归覆盖：

- 真实输入区域结构的定位、延迟解除禁用、发送点击与附件隔离。
- 非原生 role=button 控件、Enter 回退、禁用或多个发送控件的拒绝。
- 发送箭头恢复但输入框为空而禁用时的完成判定。
- 页面输入 → 适配器 → ContentController → PortRouter → TabClient → AgentOrchestrator → ToolDispatcher → 内存 VM → 工具结果回传 → 第二轮完成回复。
- 同源会话 URL 改写、工具仅执行一次，以及任务完成后无迟到超时。

模拟复用 `tests/helpers/qwen-simulator.ts` 的传输和内存 VM，把 provider 设为 DeepSeek。无需登录，不执行宿主机 Shell。模拟测试不能代替真实页面在登录态下的验证；若 DeepSeek 修改发送图标或响应节点结构，需要更新适配器与夹具。

2026-09-06 补充：DeepSeek 使用最终快照同步，允许生成过程中的 Markdown 重排和响应节点替换。只有发送箭头恢复、停止控件消失且正文稳定后才释放完整文本；提取时保留段落和列表，并排除复制按钮等控件文字。回归重现「先出现总结半句 → 替换成完整标题和列表 → 空输入框恢复发送箭头」，确认不再误报 ADAPTER_DOM_CHANGED，也不提前发送部分正文。
