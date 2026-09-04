# 项目全景技术方案：kcode

## 1. 架构拓扑与数据流图

```text
┌────────────────────────────────────────────────── Chrome 浏览器沙箱 ──────────────────────────────────────────────────┐
│                                                                                                                       │
│  ┌───────────────────────── 侧边栏 UI (Side Panel) ─────────────────────────┐   ┌────── 目标 AI 网页 (如 DeepSeek) ──────┐
│  │  - 聊天界面 (流式对话、Tool 状态折叠条)                                   │   │                                       │
│  │  - xterm.js 嵌入式终端 (实时展示 Shell 输出)                             │   │  [Content Script (适配器)]             │
│  │  - 状态指示栏 (文件夹授权状态、Linux VM 状态、网页 AI 连接状态)          │   │   ├─ 自动填入系统 Prompt & 用户指令   │
│  │                                                                          │   │   ├─ 模拟点击发送                     │
│  │  [Agent 调度状态机 (agent-core.ts)]                                      │   │   └─ MutationObserver 监听 SSE 流     │
│  └──────────────────────┬────────────────────────────────┬──────────────────┘   └───────────────────┬───────────────────┘
│                         │                                │ (Tab 内部消息总线)                       │
│                         │ (Worker 消息通道)               └──────────────────────────────────────────┘
│                         ▼
│  ┌───────────────────────── 后台 Web Worker (隔离 CPU 计算，防止界面卡顿) ─────────────────────────┐
│  │                                                                                                 │
│  │   ┌─────────────────────────── v86 x86 仿真内核 (WebAssembly) ──────────────────────────────┐   │
│  │   │  - 核心：Linux 内核 (Alpine) + BusyBox + Python/Git                                      │   │
│  │   │  - 根目录：/ (内存只读或快照恢复)                                                         │   │
│  │   │  - 挂载点：/workspace (通过 virtio-9p 挂载)                                              │   │
│  │   │  - 虚拟网卡：virtio-net (Layer 2 以太网帧输出)                                            │   │
│  │   └─────────────────┬───────────────────────────────────────────────┬───────────────────────┘   │
│  │                     │ (9P 协议 RPC)                                 │ (原始以太网/IP 包)        │
│  │                     ▼                                               ▼                           │
│  │       ┌───────────────────────────┐                   ┌───────────────────────────┐             │
│  │       │   JS 9P-Server 协议适配器  │                   │  JS 用户态 SLiRP / lwIP    │             │
│  │       └─────────────┬─────────────┘                   └─────────────┬─────────────┘             │
│  └─────────────────────┼───────────────────────────────────────────────┼───────────────────────────┘
│                        │                                               │
│                        ▼                                               ▼
│             [FileSystemAccess API]                            [Extension Fetch 引擎]
│                        │                                               │ (绕过 CORS 与网页同源策略)
└────────────────────────┼───────────────────────────────────────────────┼───────────────────────────────┘
                         ▼                                               ▼
                宿主物理硬盘工作区目录                              公网互联网 (GitHub / NPM / API)
```

---

## 2. 核心技术点与突破路径

1. **零进程的真 Linux 环境**：基于 `v86`（WebAssembly）运行轻量 x86 Alpine Linux。利用 **内存快照（Snapshot）** 机制，秒级唤醒，内存控制在 128MB。v86 运行在 `Web Worker` 中，杜绝终端计算阻塞侧边栏 UI。
2. **本地磁盘双向直通（VirtIO-9P）**：实现一个 JavaScript 版的 9P 协议服务端，将 Linux 内核的 9P 文件系统调用（`Twalk`, `Tread`, `Twrite`, `Tcreate`）直接映射为浏览器的 `FileSystemDirectoryHandle` 操作。在虚拟机内挂载到 `/workspace`，实现文件读写的实时双向同步。
3. **用户态网络转发（Strip 机制）**：Linux 虚拟网卡输出的 raw IP 包被 Web Worker 捕获，经由用户态 TCP/IP 协议栈拆包（Strip）：
   * 对 80/443 的 HTTP(S) 请求（`curl`/`git clone`），转换为 Chrome 扩展后台特权的 `fetch()` 发出，天然享有外网直连且免除 CORS；
   * 非 HTTP 请求走 WebSocket 转发。
4. **ReAct 自动驾驶闭环**：通过侧边栏接管 DeepSeek 等网页端，注入 Agent 系统提示词。网页流式输出 `<tool_call>` 时，侧边栏拦截并在 Linux 虚拟机执行对应 Shell 指令，将终端输出作为结果自动反馈回网页，直至任务完成。

---

## 3. 项目工程结构规范

```text
kcode/
├── manifest.json                  # MV3 配置 (声明 side_panel, wasm CSP, host_permissions)
├── vite.config.ts                 # 基于 @crxjs/vite-plugin 的打包配置
├── package.json
├── tsconfig.json
├── public/
│   └── v86/                       # 静态资源 (不走 JS 打包，直接放行)
│       ├── v86.wasm
│       ├── seabios.bin
│       ├── vgabios.bin
│       └── alpine-snapshot.bin    # 预先做好的 Alpine 系统就绪快照
├── src/
│   ├── types/
│   │   ├── v86.d.ts               # v86 类型补丁
│   │   └── protocol.ts            # Agent 内部通信协议定义
│   ├── sidepanel/                 # 侧边栏主应用
│   │   ├── index.html
│   │   ├── main.ts                # UI 入口
│   │   ├── App.vue / App.tsx      # 主界面 (Chat + xterm.js)
│   │   ├── agent-orchestrator.ts  # Agent 状态机调度逻辑
│   │   └── terminal-manager.ts    # xterm.js 终端与 VM 串口对接
│   ├── worker/                    # 虚拟机计算宿主 (独立线程)
│   │   ├── vm.worker.ts           # Worker 入口，负责托管 v86 实例
│   │   ├── fs-9p-server.ts        # 9P 协议与 FileSystemAccess API 映射层
│   │   └── network-strip.ts       # SLiRP 用户态协议拆包与 Extension Fetch 桥接
│   ├── content/                   # 网页端注入脚本
│   │   ├── index.ts               # 消息监听与分发
│   │   └── adapters/
│   │       ├── base.ts            # DOM 适配基类
│   │       └── deepseek.ts        # DeepSeek 网页端输入与流式监听
│   └── utils/
│       └── idb-store.ts           # 存储目录 Handle 的 IndexedDB 封装
```

---

## 4. 关键模块实现规范与代码草案

### 4.1 配置文件声明 (`manifest.json` & `vite.config.ts`)

#### `manifest.json`
```json
{
  "manifest_version": 3,
  "name": "kcode",
  "version": "1.0.0",
  "permissions": ["sidePanel", "tabs", "activeTab", "storage"],
  "host_permissions": ["<all_urls>"],
  "side_panel": {
    "default_path": "src/sidepanel/index.html"
  },
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
  },
  "content_scripts": [
    {
      "matches": ["https://chat.deepseek.com/*", "https://chatgpt.com/*"],
      "js": ["src/content/index.ts"]
    }
  ]
}
```

#### `vite.config.ts`
```typescript
import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: 'esnext',
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['v86'],
  },
});
```

---

### 4.2 核心系统协议约定 (`src/types/protocol.ts`)

```typescript
// Tool Call 标准结构
export interface ToolCall {
  id: string;
  tool: 'bash' | 'read_file' | 'write_file';
  args: Record<string, any>;
}

// Worker 通信协议
export type VMWorkerMessage =
  | { type: 'INIT'; config: { memory: number; snapshotUrl: string } }
  | { type: 'ATTACH_DIR'; handle: FileSystemDirectoryHandle }
  | { type: 'EXEC_BASH'; command: string; id: string }
  | { type: 'RAW_SERIAL_IN'; data: string };

export type VMWorkerResponse =
  | { type: 'READY' }
  | { type: 'SERIAL_OUT'; data: string }
  | { type: 'EXEC_RESULT'; id: string; output: string; exitCode: number }
  | { type: 'NETWORK_FETCH'; requestId: string; url: string; options: RequestInit };
```

---

### 4.3 9P 文件协议与本地目录桥接 (`src/worker/fs-9p-server.ts`)

这是文件直通的核心。在 Worker 中实现一个 VirtIO-9P 代理，把 9P 消息转为 `FileSystemAccess` 调用：

```typescript
export class VirtIO9PServer {
  private rootHandle: FileSystemDirectoryHandle | null = null;
  private fileHandles = new Map<number, FileSystemFileHandle | FileSystemDirectoryHandle>();
  private fidCounter = 1;

  public setRoot(handle: FileSystemDirectoryHandle) {
    this.rootHandle = handle;
    this.fileHandles.set(0, handle); // fid 0 为根路径
  }

  // 模拟处理 9P 核心报文 Twalk (路径遍历)
  public async handleWalk(parentFid: number, newFid: number, names: string[]): Promise<boolean> {
    let current = this.fileHandles.get(parentFid) as FileSystemDirectoryHandle;
    if (!current) return false;

    try {
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (i === names.length - 1) {
          try {
            // 优先尝试作为文件打开
            current = await current.getFileHandle(name) as any;
          } catch {
            // 否则作为目录打开
            current = await current.getDirectoryHandle(name);
          }
        } else {
          current = await current.getDirectoryHandle(name);
        }
      }
      this.fileHandles.set(newFid, current);
      return true;
    } catch {
      return false;
    }
  }

  // 处理 9P 读取请求 Tread (支持按 offset 读取)
  public async handleRead(fid: number, offset: number, count: number): Promise<Uint8Array> {
    const handle = this.fileHandles.get(fid);
    if (!handle || handle.kind !== 'file') return new Uint8Array(0);

    const file = await (handle as FileSystemFileHandle).getFile();
    const slice = file.slice(offset, offset + count);
    const buffer = await slice.arrayBuffer();
    return new Uint8Array(buffer);
  }

  // 处理 9P 写入请求 Twrite
  public async handleWrite(fid: number, offset: number, data: Uint8Array): Promise<number> {
    const handle = this.fileHandles.get(fid);
    if (!handle || handle.kind !== 'file') return 0;

    const fileHandle = handle as FileSystemFileHandle;
    const writable = await (fileHandle as any).createWritable({ keepExistingData: true });
    await writable.seek(offset);
    await writable.write(data);
    await writable.close();
    return data.length;
  }
}
```

---

### 4.4 用户态网络转发拆包 (`src/worker/network-strip.ts`)

处理虚拟机通过 `virtio-net` 发出的以太网数据包，拦截 HTTP(S) 并通过扩展特权 `fetch` 发出：

```typescript
export class NetworkStripper {
  constructor(private onFetchRequest: (url: string, options: RequestInit) => Promise<Response>) {}

  /**
   * 拦截从 v86 virtio-net 网卡出来的 Layer 2 以太网帧
   */
  public async onGuestEthernetFrame(frame: Uint8Array): Promise<void> {
    // 1. 解析以太网帧头 (14 字节) -> 判断是否为 IPv4 (0x0800)
    const ethType = (frame[12] << 8) | frame[13];
    if (ethType !== 0x0800) return;

    // 2. 解析 IP 报头 -> 判断是否为 TCP (协议号 6)
    const ipHeaderLength = (frame[14] & 0x0f) * 4;
    const protocol = frame[23];
    if (protocol !== 6) return;

    // 3. 解析 TCP 报头与端口 (例如目标端口 80 或特定内部代理端口)
    const tcpOffset = 14 + ipHeaderLength;
    const destPort = (frame[tcpOffset + 2] << 8) | frame[tcpOffset + 3];

    // 4. 对 80 / 443 等 HTTP 流量执行数据段提取
    const tcpHeaderLength = ((frame[tcpOffset + 12] >> 4) & 0x0f) * 4;
    const payloadOffset = tcpOffset + tcpHeaderLength;
    const payload = frame.slice(payloadOffset);

    if (payload.length > 0 && (destPort === 80 || destPort === 8080)) {
      await this.handleHttpPayload(payload);
    }
  }

  private async handleHttpPayload(payload: Uint8Array) {
    const rawText = new TextDecoder().decode(payload);
    // 粗粒度提取 HTTP 请求行，通过 Chrome 扩展后台 fetch 执行真实网络请求
    const match = rawText.match(/(GET|POST|PUT|DELETE)\s+([^\s]+)\s+HTTP/);
    if (match) {
      const [, method, url] = match;
      try {
        // 委托给 SidePanel / Background 执行无 CORS 限制的请求
        await this.onFetchRequest(url, { method });
      } catch (err) {
        console.error('Fetch 转发失败:', err);
      }
    }
  }
}
```

---

### 4.5 Agent 闭环调度引擎 (`src/sidepanel/agent-orchestrator.ts`)

```typescript
export class AgentOrchestrator {
  private isProcessing = false;

  constructor(
    private postMessageToTab: (msg: any) => Promise<any>,
    private execVmBash: (cmd: string) => Promise<string>,
    private appendUiMessage: (role: string, text: string) => void
  ) {}

  // 启动任务
  public async runTask(userGoal: string) {
    if (this.isProcessing) return;
    this.isProcessing = true;

    const systemPrompt = `
【重要】你是运行在本地真实 Linux 环境中的 AI 程序员。
本地仓库挂载在 /workspace 目录下。你可以调用 bash 工具执行任何命令（如 ls, grep, cat, python, git 等）。
当需要执行命令时，必须且只能输出如下格式：
<tool_call>
{"tool": "bash", "args": {"cmd": "cd /workspace && ls -la"}}
</tool_call>
系统执行后会返回 <tool_result>，你根据结果决定下一步操作。若已完成任务，请输出最终结论。
`;

    const fullPrompt = `${systemPrompt}\n用户任务: ${userGoal}`;
    await this.stepLoop(fullPrompt);
  }

  private async stepLoop(promptToSend: string) {
    this.appendUiMessage('user', promptToSend);

    // 1. 发送给网页 AI (DeepSeek/ChatGPT) 并开启流式监听
    let responseText = '';
    await this.postMessageToTab({
      action: 'SEND_AND_WATCH',
      prompt: promptToSend,
      onChunk: (chunk: string) => {
        responseText += chunk;
        this.appendUiMessage('ai-stream', responseText);
      },
    });

    // 2. 检测是否存在工具调用
    const toolCallMatch = responseText.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
    if (toolCallMatch) {
      try {
        const toolCall = JSON.parse(toolCallMatch[1].trim());
        if (toolCall.tool === 'bash') {
          this.appendUiMessage('tool', `正在执行: ${toolCall.args.cmd}`);
          
          // 3. 在 WebAssembly Linux 虚拟机中执行 Bash
          const output = await this.execVmBash(toolCall.args.cmd);
          
          // 4. 将输出组装为 tool_result，再次提交给网页形成循环
          const nextPrompt = `<tool_result>\n${output}\n</tool_result>`;
          await this.stepLoop(nextPrompt);
        }
      } catch (e) {
        console.error('Tool Call 解析/执行失败', e);
        this.isProcessing = false;
      }
    } else {
      // 无工具调用，任务闭环结束
      this.isProcessing = false;
    }
  }
}
```

---

## 5. 复制给 AI 直接执行的阶段式 Prompt

你可以将以下提示词按阶段发给编程助手，逐步生成代码：

### 阶段一：工程脚手架与 UI 基础
> “你好，请按照以下规格为我构建 **kcode** 扩展的第一阶段：
> 1. 初始化 `Vite` + `TypeScript` + `@crxjs/vite-plugin` 目录结构，配置好包含 `wasm-unsafe-eval` 和 `sidePanel` 声明的 `manifest.json`；
> 2. 实现侧边栏界面 `src/sidepanel/`：
>    - 顶部工具栏：包含‘选择工作目录’按钮（点击唤起 `window.showDirectoryPicker` 并将 handle 存入 IndexedDB）以及状态指示；
>    - 中间区域：集成 `xterm.js` 终端视图用于显示控制台输出，以及一个消息流对话列表；
>    - 底部区域：用户指令输入框；
> 3. 输出完整的 `package.json`、`vite.config.ts`、`sidepanel.html` 及相关 TypeScript 源码。”

### 阶段二：v86 Web Worker 与 9P 协议文件挂载
> “现在继续进行第二阶段：
> 1. 在 `src/worker/vm.worker.ts` 中引入 `v86`，并建立一个能在 Web Worker 中运行的 Linux 虚拟机实例；
> 2. 编写 `src/worker/fs-9p-server.ts`，实现基于 `FileSystemDirectoryHandle` 的 9P 文件服务层，将主机文件夹代理给 Linux 内核，实现 `/workspace` 的读写同步；
> 3. 在 Worker 与 UI 之间建立串口通信机制，实现 `execBash(cmd): Promise<string>` 接口；
> 4. 输出代码并说明如何放置 `v86.wasm`、`seabios.bin` 和 Alpine 镜像快照资产。”

### 阶段三：网页适配器与 ReAct 闭环调度
> “现在进行第三阶段开发：
> 1. 编写 `src/content/adapters/deepseek.ts`，实现自动寻找 DeepSeek 网页输入框填入提示词、触发发送事件、并用 `MutationObserver` 监听 SSE 回复并回传侧边栏；
> 2. 编写 `src/sidepanel/agent-orchestrator.ts`，把网页端捕获到的流式文本进行 `<tool_call>` 正则匹配；
> 3. 匹配成功后自动调用 Worker 的 `execBash`，并将执行结果打上 `<tool_result>` 标记，自动提交回网页，完成多轮自动化操作闭环。”
