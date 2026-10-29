# AI PM Desktop（客户端 v2）

AI PM 平台的本地客户端，用来替代 `ai-pm-client`。它负责从平台认领需求，然后驱动 Codex、Claude Code、ZCode 完成方案、开发、提测和上线。目标是 Mac 和 Windows 共用一份代码。

设计文档：[AI PM 客户端 v2 设计文档](https://claude.ai/artifact/CtQXtwTM2TopdZ3gQSdBGG)

## 当前进度

P1（核心骨架、Mac 客户端）和 P2（多执行器、AI 评审、多项目）已完成，Mac 上已替代旧客户端接真实需求。P3 的 Windows 适配代码和安装包已完成，还没在 Windows 真机上验证。

已完成：

核心
- SQLite 存储，使用 Electron 自带 Node 的 `node:sqlite`，不需要编译原生模块
- 平台写入发件箱：request_id 固定，结果不确定就原样重发，靠平台去重；平台返回结构化错误码，开启接单前会先核对平台版本
- 单一状态机和调度循环；OAuth 登录（动态注册客户端、PKCE、令牌临近过期自动续期，续期失败时提示重新登录）
- 每项任务的同步告警与执行错误分别记录。成功读取平台后自动解除同步告警，不清除执行错误；时间线保留失败与恢复记录。升级时将有明确网络错误证据的旧待验收告警归入同步记录，等待实际同步成功后复位。
- 待验收在任务列表单独展示，不占项目接单容量；继续同步平台验收结果，退回开发后重新计入容量。等待测试、产品回复或人工处理的需求仍占容量。
- 只读联调命令 `probe`；项目位于仓库子目录（如 `server/`）时，Agent 在每个检出的相同子目录里运行
- 多项目：一个客户端同时服务多个项目。每个项目单独登录（平台的授权绑定一个项目）、单独连接和订阅，有自己的数据目录、任务、日志和工作区；执行器和名额所有项目共用。数据目录下的 `projects.json` 记着共用设置和各项目的位置，升级前的数据目录原地成为第一个项目
- 添加项目：输入平台入口（支持子路径或完整 MCP 地址）→ 浏览器登录并选择授权项目 → 自动读取项目 ID、仓库、订阅资源和默认分支 → 选择本地仓库或子目录并校验 origin、分支 → 完成绑定。未完成绑定不接单；授权只保存在本机，取消或失败的临时绑定会清理。项目元数据默认只读，开发起始分支可在高级设置覆盖；已有项目沿用原授权、分支、任务和接单设置，可主动从平台更新元数据。

流程
- 方案：先分析不改代码，业务问题由你选择，确认后才开发；Bug 走同样的方案确认，方案写清现象、根因和修复
- 开发、再改一下、和产品对齐；关联 Bug 的修复合回所属需求分支，所属需求在修复和复测期间等待
- 协同排查：在用完即删的临时检出里运行，可以联网、SSH 和调用配置好的工具；对环境只读由提示词约束
- 提测和上线：发布 Agent 按你写的发布说明合并、部署和验证；停下时可以一键继续、补充说明后继续、交给开发修复或人工确认已完成。发布过程显示在需求自己的页面里
- AI 评审：开发完成后在提测和评审之间选一个；评审用你选的执行器的专家模型，不改代码，可以构建和跑测试，产出评审文档、修复名单和修复方案。你勾选条目返回开发、补充意见后重新评审，或者不修直接提测；同一个执行器再评审时在原会话里复查

执行器
- Codex：`codex exec --json` 以分离进程运行，客户端重启后能接回正在运行的轮次
- Claude Code：`claude -p --output-format stream-json --json-schema` 以分离进程运行，会话 ID 由客户端预先指定，`--resume` 继续。不加载用户设置和用户的 MCP 服务
- ZCode：客户端起一个分离的 runner（`dist/core/executors/zcode-runner.js`），由它通过 `zcode app-server --stdio` 跑一轮，事件写进运行日志，客户端重启后照样接回。用 ZCode 里登录的账号和模型服务商，模型列表和推理强度从 ZCode 读取；ZCode 不强制输出格式，结果由客户端校验，不合格就在同一会话里要求修正。ZCode 配置里如果有指向 AI PM 平台的 MCP 服务，执行器会拒绝启动
- 所有阶段的 Agent 都不开沙箱、不限工具，可以执行任何命令和联网（Codex `--dangerously-bypass-approvals-and-sandbox`，Claude Code `bypassPermissions`，ZCode yolo 模式）。方案和评审不改代码、除发布外不推送合并、排查对环境只读，这些规则写在提示词里
- 三个执行器可以同时启用，新需求交给排在前面、还有空闲名额的执行器；一个需求从头到尾留在同一个执行器，评审可以换执行器
- worktree 管理和 `.ai-pm/` 上下文文件。任务结束后按设置的天数自动删除工作区，需求分支保留；发布 Agent 在发布工作区里建的分支，提交已在远端的随工作区删除。有未提交改动的工作区不会自动删除，任务详情里会列出这些文件；结束的任务也可以在详情里马上删除工作区
- Agent 启动前，客户端用项目 OAuth 下载需求及评审中的附件原文件，放到工作区的 `.ai-pm/attachments/<附件 ID>/`；`.ai-pm/attachments.json` 和 `task.json` 给出本地路径与 SHA-256。已有文件校验后复用，下载失败只重试该任务，Agent 不接触平台凭证。平台需支持附件 GET 接口的项目 OAuth 认证。

Mac 客户端
- 主窗口：待你处理、全部任务、任务详情（需求原文、进度和时间线、日志、方案、评审、改动）、设置
- 设置：按项目切换的登录、项目绑定、发布说明、环境说明和接单；所有项目共用的执行器和模型（从本机 CLI 读取模型列表）、工作区保留天数；可以从旧客户端导入
- 系统通知、菜单栏常驻、开机自启；从 Finder 或开机启动时从登录 shell 读取 PATH
- `npm run dist:mac` 打包并用 Apple Development 证书签名，更新后钥匙串不再重复询问
- Windows：`npm run dist:win` 打出 NSIS 安装包（在 Mac 上也能打）；进程靠 PowerShell 读启动时间识别；npm 装的 `.cmd` CLI 经 cmd.exe 按 cross-spawn 的规则转义启动；提示词一律从 stdin 传给 Agent；托盘用图标；开机启动带 `--hidden` 不开窗口；仓库开启 git 长路径

测试
- 本地假平台和三个执行器的假 CLI，测试覆盖全流程和常见故障
- 可选：用真实执行器在临时仓库上跑冒烟测试；从源码编译平台在本机做真实平台联调

未开始：

- Windows 真机验证；Windows 代码签名证书（没有证书时安装包未签名，安装时系统会提示未知发布者）

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
npm run dist:win                                       # 打包成 release/AI PM Setup <版本>.exe（Windows 安装包，Mac 上也能打）
npm run build && npm run demo                          # 在假平台上打开窗口，任务处于各种状态，用来看界面
npm run build && npm run demo -- --screenshots <目录> --theme dark   # 自动截图，可选 light / dark
```

界面用 React，样式全部在 `src/renderer/styles.css` 的设计变量里：暖色纸感背景、陶土橙点缀、衬线标题，自动跟随系统浅色和深色模式。

## 安装版

`npm run dist:mac` 会用钥匙串里的 Apple Development 证书签名（在 Xcode › 设置 › 帐户里用 Apple ID 免费创建）。这张证书带 Team ID，钥匙串的“始终允许”按 Team ID 记，所以更新后不会再询问；没有这张证书时会退回临时签名，每次更新都会再问一次。打出的 `AI PM.app` 和开发版共用数据目录 `~/Library/Application Support/ai-pm-desktop`。第一次运行时会自动设为开机启动，可以在设置的“启动”里关掉。开机启动后客户端只在菜单栏运行，不打开窗口；关掉窗口也一样会继续运行。从 Finder 或开机启动时，客户端会从登录 shell 读取 PATH，这样 Agent 能用到 Homebrew 装的 node、npm 等工具。第一次连接内网平台时，macOS 会询问是否允许访问本地网络，需要点允许。

### Windows

`npm run dist:win` 打出 `release/AI PM Setup <版本>.exe`，在 Mac 或 Windows 上都能打（会下载 Windows 版 Electron）。安装包还没有签名，第一次运行时 Windows 会提示“已保护你的电脑”，点“更多信息”再点“仍要运行”。

Windows 上需要：Git for Windows；至少一个执行器——Codex（`codex.exe`，或 `npm i -g @openai/codex` 装出的 `codex.cmd`）、Claude Code（官方安装器装的 `%USERPROFILE%\.local\bin\claude.exe`，或 npm 装的 `claude.cmd`）、ZCode（装在 `%LOCALAPPDATA%\Programs\ZCode`）；以及 Agent 开发要用的 node、npm 等在 PATH 里。设置里的“自动探测”会按这些位置和 PATH 找。数据目录是 `%APPDATA%\ai-pm-desktop`。客户端会给业务仓库开启 `core.longpaths`，避免工作区路径过长。

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

平台挂在子路径下时，MCP 地址要包含完整前缀，例如 `https://portal.shiyugame.com/syai/zhiqu/mcp`。OAuth 登录和刷新会先按标准地址发现元数据，标准地址返回 404 时再尝试挂载路径内的元数据地址。更换地址不需要改项目 ID 或 `ai-pm://projects/…/work` 订阅 URI；旧授权失效时在该项目的设置里重新登录。

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
