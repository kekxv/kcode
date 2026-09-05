# kcode 中文说明

kcode 是一个 Chrome Side Panel 扩展：它将网页聊天 AI 与受限的本地 VM 工作区连接。AI 只能使用明确的工具调用操作用户选定的目录，高风险能力始终需要用户确认。

## 支持站点

- DeepSeek：`https://chat.deepseek.com/`
- 通义千问：`https://chat.qwen.ai/`
- Google AI Studio：`https://aistudio.google.com/`
- ChatGPT：`https://chatgpt.com/`
- HIX.AI：`https://hix.ai/ai-chat`
- Gemini：`https://gemini.google.com/`

登录、模型和配额由各服务提供商决定。页面控件无法精确识别时，扩展会停止，而不会猜测点击。

## 安装与验证

```sh
npm ci
npm run verify
```

在 Chrome 打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，并选择 `dist/` 目录。

## 权限与数据

- 默认 `confirm-each`：每次工具、文件变更和结果发送都需要确认。
- Auto 和 WISP 网络各自需要高风险确认；停止会撤销会话授权。
- 内容脚本只在上述聊天站点运行。`<all_urls>` 权限仅用于 VM 内受控 HTTPS `fetch`，不用于控制其他网页。
- 工作记录与任务恢复断点经过脱敏后存入用户选择目录的 `.session/kcode-history.sqlite`。

## VM 资源与启动

`public/v86/` 中的内核、initramfs、SquashFS 根文件系统和 v86/BIOS 是扩展启动与 CI 必需的锁定资源，已提交到 Git，使干净 checkout 可以验证和构建。

扩展不会分发 VM 启动快照。首次离线启动就绪、且尚未挂载工作区时，扩展会在用户自己的浏览器中保存对应内存规格的本地快照；后续相同规格的离线启动可以复用。联网启动和不同内存规格始终冷启动，因此不会将旧 VM 中的设备、网络或工作区状态带入新的授权会话。本地快照不会进入扩展包、Git 或中继服务。

资源改动后必须执行：

```sh
npm run assets:verify
```

英文说明见 [README.md](README.md)。
