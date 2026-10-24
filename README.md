# AI PM Desktop（客户端 v2）

AI PM 平台的本地客户端，用来替代 `ai-pm-client`。它负责从平台认领需求，然后驱动 Codex、Claude Code、ZCode 完成方案、开发、提测和上线。目标是 Mac 和 Windows 共用一份代码。

设计文档：[AI PM 客户端 v2 设计文档](https://claude.ai/artifact/CtQXtwTM2TopdZ3gQSdBGG)

## 当前进度：P1 核心骨架

已完成：

- SQLite 存储，使用 Electron 自带 Node 的 `node:sqlite`，不需要编译原生模块
- 平台写入发件箱：request_id 固定，结果不确定就原样重发，靠平台去重
- 单一状态机和调度循环
- Codex 执行器：`codex exec --json` 以分离进程运行，客户端重启后能接回正在运行的轮次
- worktree 管理和 `.ai-pm/` 上下文文件
- 本地假平台和假 Codex，测试覆盖全流程和常见故障
- 最小 Electron 外壳（只有托盘）和命令行入口

未开始：

- Claude Code / ZCode 执行器、AI 评审（P2）
- 主窗口、设置界面、通知、Windows 打包（P3）
- OAuth 登录。现在用静态令牌，见 `StaticToken`

## 开发

```bash
npm install
npm test            # 全量测试，约 20 秒，只用本地假平台和临时仓库
npm run typecheck
npm run build
```

## 本地试运行（命令行）

数据目录放在仓库之外：

```bash
npx tsx src/cli.ts --data ~/ai-pm-data init --config settings.json --token-file token.txt
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
| `src/core/executors/` | 执行器接口和 Codex 实现 |
| `src/core/flows/` | 各阶段的提示词和输出 schema |
| `src/main/main.ts` | Electron 外壳 |
| `test/` | 假平台、假 Codex 和测试 |
