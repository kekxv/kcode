# kcode 中文说明

kcode 是一个 Chrome MV3 Side Panel 扩展：它让已登录的聊天网页在一次性 v86 Alpine VM 中请求受限工具。用户选定的目录只会通过 9P 挂载到 `/work`；每次工具调用后 VM 都会销毁。AI 只能使用明确的工具调用操作用户选定目录，高风险能力始终需要用户确认。

英文说明见 [README.md](README.md)。

## 前提条件

- Node.js 22.12 或更高版本
- Chrome 116 或更高版本
- 仅在重建 VM 客体资源时需要 Docker 或 Podman
- 可选 VM 联网需要用户自己运行或信任的 `wss://` WISP 中继

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

在 Chrome 打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，并选择 `dist/` 目录。登录任一支持站点后，从扩展操作菜单打开 kcode Side Panel。

## 权限与数据

- 默认 `confirm-each`：每次工具、文件变更和结果发送都需要确认。
- Auto 和 WISP 网络各自需要高风险确认；停止会撤销会话授权。
- 内容脚本只在上述聊天站点运行。较宽的主机访问权限仅服务于已批准的网络工具，不用于控制其他网页。
- 工作记录与任务恢复断点经过脱敏后存入用户选择目录的 `.session/kcode-history.sqlite`。

扩展不会设置或修改提供商原生的系统提示词。可选自定义 Agent 指令会在固定安全策略之后，附加到第一条由 kcode 控制的普通用户消息中，因此不能削弱工作区、审批或网络控制。页面 UI 变动或存在歧义控件时会停止，而不会猜测点击。

## WISP 中继与 Fetch

在 Side Panel 中保存严格格式的 `wss://host/path` URL 后才能启用联网。含凭据、查询字符串、片段、空白、`ws:` 或路径穿越编码的 URL 会被拒绝。保存 URL 不等于同意；选择网络仍需要与确切工作区和 URL 绑定的一次会话确认。

WISP 会按照中继策略，为 VM 提供常见 DNS/HTTPS/Git/NPM 流程所需的出站 TCP；它不提供原始 IP、任意 UDP、入站端口、匿名性或可信中继。联网 VM 可在 TLS 内上传可读且未受保护的 `/work` 数据，且不会经过结果脱敏。

扩展不运营公共中继。请使用你本人或团队运行的中继，例如 `wss://relay.example.com/wisp`。小型 Docker 部署可使用 `deploy/wisp/` 中的受限模板：它只允许到 80、443、9418、22 端口的出站 TCP，拒绝直接 IP、私有和回环目标，禁用 UDP 并限制并发流。普通 Cloudflare HTTP 代理 URL 不是 WISP 端点；Cloudflare 是否可承载兼容中继取决于账户的 Worker/Sockets 和出站策略。

Agent 可以请求 HTTPS `fetch` 工具调用。它会在一次性 VM 内以有界 `curl` 命令运行，要求已启用 WISP 网络和既有风险确认；在 `confirm-each` 模式下同样会显示审批。它不是不受限制的浏览器页面 fetch 桥接。

## 工作记录与重启恢复

使用 **启用工作记录（写入 .session）** 明确授予可选的记录写入权限。完成任务会在同样经过密钥脱敏和大小限制后存入所选目录的 `.session/kcode-history.sqlite`；打开 Side Panel 不会创建该目录或数据库。可使用 **清除工作记录** 删除记录文件。

启用可选 `.session` 写入后，kcode 会在每项任务开始前保存脱敏检查点。浏览器或 Side Panel 重启后，会显示 **恢复上次任务**；它绝不会自动发送，必须在对应提供商页面点击恢复。Auto、WISP 网络、VM 进程、待处理工具审批和未提交事务不会恢复，其同意和审查边界必须重新开始。

## VM 资源与启动

`public/v86/` 中的内核、initramfs、SquashFS 根文件系统和 v86/BIOS 是扩展启动与 CI 必需的锁定资源，已提交到 Git，使干净 checkout 可以验证和构建。

扩展不会分发 VM 启动快照。首次离线启动就绪、且尚未挂载工作区时，扩展会在用户自己的浏览器中保存对应内存规格的本地快照；后续相同规格的离线启动可以复用。联网启动和不同内存规格始终冷启动，因此不会将旧 VM 中的设备、网络或工作区状态带入新的授权会话。本地快照不会进入扩展包、Git 或中继服务。

资源改动后必须执行：

```sh
npm run assets:verify
```

## 限制

MVP 支持普通文件/目录、受限读取/写入/删除、非原子但可恢复的重命名、最多 20 轮任务，以及每次工具调用一个 VM。不支持符号链接、硬链接、设备文件、原始网络和可靠的物理擦除。
