# AI PM Desktop（客户端 v2）

AI PM 平台的本地客户端，用来替代 `ai-pm-client`。它负责从平台认领需求，然后驱动 Codex、Claude Code、ZCode 完成方案、开发、提测和上线。目标是 Mac 和 Windows 共用一份代码。

设计文档：[AI PM 客户端 v2 设计文档](https://claude.ai/artifact/CtQXtwTM2TopdZ3gQSdBGG)

## 当前进度：P1 核心骨架

已完成：

- SQLite 存储，使用 Electron 自带 Node 的 `node:sqlite`，不需要编译原生模块
- 平台写入发件箱：request_id 固定，结果不确定就原样重发，靠平台去重
- 单一状态机和调度循环
- Codex 执行器：`codex exec --json` 以分离进程运行，客户端重启后能接回正在运行的轮次
- Claude Code 执行器：`claude -p --output-format stream-json --json-schema` 以分离进程运行，会话 ID 由客户端预先指定，`--resume` 继续。不加载用户设置和用户的 MCP 服务；只读阶段只放行读取类工具和只读命令
- ZCode 执行器：客户端起一个分离的 runner（`dist/core/executors/zcode-runner.js`），由它通过 `zcode app-server --stdio` 跑一轮，事件写进运行日志，客户端重启后照样接回。用 ZCode 里登录的账号和模型服务商，模型列表和推理强度从 ZCode 读取；ZCode 不强制输出格式，结果由客户端校验，不合格就在同一会话里要求修正。ZCode 配置里如果有指向 AI PM 平台的 MCP 服务，执行器会拒绝启动
- 三个执行器可以同时启用，新需求交给排在前面、还有空闲名额的执行器；一个需求从头到尾留在同一个执行器
- worktree 管理和 `.ai-pm/` 上下文文件
- 本地假平台和三个执行器的假 CLI，测试覆盖全流程和常见故障
- 最小 Electron 外壳（只有托盘）和命令行入口
- OAuth 登录：动态注册客户端、PKCE、令牌临近过期自动续期，续期失败时提示重新登录
- 只读联调命令 `probe`：已在真实平台上验证登录、项目绑定、work_list 和订阅
- 项目位于仓库子目录（如 `server/`）时，agent 在每个检出的相同子目录里运行

未开始：

- AI 评审（P2）
- 主窗口、设置界面、通知、Windows 打包（P3）

## 开发

```bash
npm install
npm test            # 全量测试，约 20 秒，只用本地假平台和临时仓库
npm run typecheck
npm run build
npm run smoke -- --executor codex|claude|zcode --model <模型ID> --effort low   # 可选：用真实执行器在临时仓库和假平台上跑一遍，会调用几次模型
npm run check:local-platform -- --platform <ai-pm-system 目录>   # 可选：从源码编译平台，在本机临时库上用 OAuth 走完需求、Bug、协同、提测、上线
npm start                                              # 构建并打开桌面客户端（使用你本机的数据目录）
npm run dist:mac                                       # 打包成 release/mac-arm64/AI PM.app，复制到 /Applications 即可使用
npm run build && npm run demo                          # 在假平台上打开窗口，任务处于各种状态，用来看界面
npm run build && npm run demo -- --screenshots <目录> --theme dark   # 自动截图，可选 light / dark
```

界面用 React，样式全部在 `src/renderer/styles.css` 的设计变量里：暖色纸感背景、陶土橙点缀、衬线标题，自动跟随系统浅色和深色模式。

## 安装版

`npm run dist:mac` 会用钥匙串里的 Apple Development 证书签名（在 Xcode › 设置 › 帐户里用 Apple ID 免费创建）。这张证书带 Team ID，钥匙串的“始终允许”按 Team ID 记，所以更新后不会再询问；没有这张证书时会退回临时签名，每次更新都会再问一次。打出的 `AI PM.app` 和开发版共用数据目录 `~/Library/Application Support/ai-pm-desktop`。第一次运行时会自动设为开机启动，可以在设置的“启动”里关掉。开机启动后客户端只在菜单栏运行，不打开窗口；关掉窗口也一样会继续运行。从 Finder 或开机启动时，客户端会从登录 shell 读取 PATH，这样 Agent 能用到 Homebrew 装的 node、npm 等工具。第一次连接内网平台时，macOS 会询问是否允许访问本地网络，需要点允许。

## 本地试运行（命令行）

数据目录放在仓库之外：

```bash
npx tsx src/cli.ts --data ~/ai-pm-data init --config settings.json
npx tsx src/cli.ts --data ~/ai-pm-data login     # 在浏览器里完成 OAuth 登录
npx tsx src/cli.ts --data ~/ai-pm-data probe     # 只读联调，任何写操作都会在发出前被拒绝
npx tsx src/cli.ts --data ~/ai-pm-data run
npx tsx src/cli.ts --data ~/ai-pm-data status
npx tsx src/cli.ts --data ~/ai-pm-data do confirmPlan '["task:tsk_xxx", {}]'
```

`settings.json` 的字段见 `src/core/types.ts` 里的 `Settings`。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/core/store.ts` | SQLite 表：tasks、runs、outbox、events、settings |
| `src/core/scheduler.ts` | 状态机：tick 处理本地工作，reconcile 同步平台状态 |
| `src/core/commands.ts` | 界面上每个按钮对应的命令 |
| `src/core/engine.ts` | 定时器、平台订阅、兜底轮询 |
| `src/core/platform/` | MCP 客户端和发件箱 |
| `src/core/executors/` | 执行器接口，Codex、Claude Code、ZCode 实现和 ZCode runner |
| `src/core/flows/` | 各阶段的提示词和输出 schema |
| `src/main/main.ts` | Electron 外壳 |
| `test/` | 假平台、假 Codex / Claude Code / ZCode 和测试 |
