# ZCode 运行中追加指令：真实会话探测

2026-11-04。独立分支 `codex/zcode-steering-spike`，基于 `50993e1`。
仅使用新建的临时工作区、新建 ZCode 会话和 30 秒本地等待命令；没有启动 AI PM 调度器或连接平台任务池。

## 实测结论

本机 ZCode CLI 0.17.1 / GLM-5.3（个人 Coding Plan，默认推理强度 max）支持将运行中补充指令注入同一轮次。它不必取消正在执行的工具命令：本次在命令运行时接收消息，命令完成后排空引导队列，随后继续当前轮次。

这不是“立即停止当前 SQL/命令”的能力，也不能保证模型一定采纳每条指令。

## 两次探测

| 条件 | 传输/注入 | 当前工具命令 | 最终回复 |
| --- | --- | --- | --- |
| 初始提示要求 `ORIGINAL_TOKEN`；中途英文消息要求改成 `STEER_TOKEN` | 同轮 `turn.steerQueued` → `turn.steerDrained` | 正常完成，只执行一次 | 仍为 `ORIGINAL_TOKEN` |
| 初始提示明确后续用户更新覆盖旧要求；中途中文消息要求改成 `STEER_TOKEN` | 同轮 `turn.steerQueued` → `turn.steerDrained` | 正常完成，只执行一次 | `STEER_TOKEN` |

第二次改变了初始提示和补充消息语言，不能据此把第一次失败归因于某一个因素。已证实的是传输和同轮注入可行、第二次实际执行了新指令；还未验证不同模型/版本下的可靠性。

两次 `v4/command` 回执都为 `status: accepted`、`result.delivery: queue`，但实际事件是当前轮次的 steer 队列及排空，不能仅用这个 `queue` 字段判断为“下一轮才处理”。应结合事件及 turnId 判断。

## 已测试的发送方式

沿用客户端已有的账号桥接、模型选择与 `session/create` / `session/send` / `session/subscribe`，在本次 app-server 连接内发送：

```json
{
  "method": "v4/command",
  "params": {
    "commandId": "<唯一消息标识>",
    "clientId": "ai-pm-steering-probe",
    "connectionId": "<连接标识>",
    "sessionId": "<当前会话>",
    "type": "sendText",
    "issuedAt": 0,
    "clientMode": "desktop-continuous",
    "payload": {
      "text": "<补充指令>",
      "content": "<同一补充指令>",
      "inputId": "<唯一输入标识>",
      "requestedDelivery": "guide",
      "attachments": []
    }
  }
}
```

上面记录的是实测包络，尚未验证哪些冗余字段可以删除。入队事件中的 inputId 采用 commandId，不能假定始终等于 payload.inputId。

## 复现

需要本机安装并登录 ZCode，使用已有账号，会产生真实模型调用：

```sh
npx tsx scripts/probe-zcode-steering.ts
npx tsx scripts/probe-zcode-steering.ts --cooperative
```

脚本输出临时证据目录。`report.json` 的 `followedInstruction` 表示模型实际是否使用最新回复要求，`steeringEvents` 可核对同轮注入。退出码为零仅表示探测流程完成，不代表模型一定采纳指令。

首次证据：`/var/folders/ll/fmybp8917wg7l7mdhdqk_2q00000gn/T/ai-pm-zcode-steer-uuM5tn/`。
第二次证据：`/var/folders/ll/fmybp8917wg7l7mdhdqk_2q00000gn/T/ai-pm-zcode-steer-QnfSS8/`。

## 接入约束（现已按下节实现）

- 给现有分离 runner 增加本机消息通道，不新建第二个会话写入同一任务。
- 持久化唯一消息标识、所属 run/session/turn、待发送状态和回执。内部用 steerDrained 判断注入；界面按用户要求只展示发言，不显示接收或注入状态。模型是否采纳不自动推断。
- 正确处理消息恰好撞上轮次结束、重复发送、客户端重启和能力不支持；不能静默丢消息或偷偷改为停止任务。
- 在提示词里明确最新用户补充的优先级，并保持输出格式约束及平台凭据隔离。
- Windows、其他模型、原生 app-server 断线重连尚未实测。

## 客户端实现（同分支，未部署）

已接入现有 ZCode 分离 runner。`run-messages.ts` 用私有运行目录的原子消息文件跨进程投递；客户端重启不终止 runner，固定消息 ID 的重试不会重复提交。投递回执和生命周期文件仅供内部使用。

日志视图底部提供补充指令输入框，用户发言直接进入同一对话流，不显示接收、排队、注入状态标签；失败在对话和输入区明确显示。输入保留到发送成功。同一需求下查看发布批次日志时，消息准确路由给实际批次 run，而不是父需求的旧会话。

模拟测试覆盖客户端重启、重试去重、冲突消息 ID、任务归属、版本不支持、轮次结束早于消息回执，以及用户消息的展示。全套 222 项测试、类型检查与构建通过。

真实新 runner + 文件投递链路也已实测通过：运行中的 30 秒命令自然结束，只有一次工具执行和一个轮次，唯一用户消息被注入原轮次，最终结果为 `{"token":"STEER_TOKEN"}`。证据保存在 `/var/folders/ll/fmybp8917wg7l7mdhdqk_2q00000gn/T/ai-pm-message-smoke-YUgFa0/report.json`。

可用 `npx tsx scripts/smoke-zcode-messages.ts` 单独复现这条真实链路；需要本机 ZCode 已登录，会产生模型调用。现有正式客户端、运行中的任务和发布均未替换或重启。

## 三执行器统一接入

该探测只以 ZCode 为起点，功能范围包括 Codex、Claude Code、ZCode。共用同一个消息命令、持久化投递目录和对话输入框，不给用户展示接收/注入标签；原生投递语义保持各自协议，不把 Claude 的后续队列宣称为 Codex 的同轮 steering。

- Codex：`turn/steer` 携带原 turn ID 和稳定用户消息 ID，不调用 interrupt。分离 runner 通过原生 app-server 内存登录接入当前账号，隔离配置与用户 MCP；仅链接会话历史目录，并共用原状态库，避免复制历史。显式配置覆盖仍生效。只读授权进程不创建线程或连接 MCP 工具。
- Claude Code：持续 stream-json 输入，重放用户消息用于关联；投递到同一进程的原生队列，不发送 interrupt。管道写入成功即可继续输入，长工具结束后再处理的原生回执不会让输入框一直锁住；已排队消息处理完前不释放运行名额。
- ZCode：沿用上文实测的 v4 sendText + guide。

真实 Codex CLI 0.166.0-alpha.5.1 / gpt-6.1-sol 已验证：一个 20 秒命令自然完成，只有一次执行，一条用户消息，最后返回 STEER_TOKEN。证据：`/var/folders/ll/fmybp8917wg7l7mdhdqk_2q00000gn/T/ai-pm-codex-message-lfmNC1/report.json`。

Claude Code 2.1.285 实际启动成功，但本机账号返回 on hold / restricted，未进入模型执行。因此只完成模拟协议回归，不能声称真实 Claude 模型插话已验证。证据：`/var/folders/ll/fmybp8917wg7l7mdhdqk_2q00000gn/T/ai-pm-claude-message-waB71q/report.json`。

复现：`npx tsx scripts/smoke-run-messages.ts codex` 或 `claude`。仅在临时目录进行本地命令测试，不连接 AI PM 平台，也不修改现有运行中的任务。

同一真实 Codex 会话另起后续轮次也已验证：session ID 保持不变，返回 RESUMED_TOKEN，隔离目录没有 auth.json。证据位于上述 Codex 证据目录的 runs/resume/report.json。

统一接入后的全套 226 项测试通过（110 秒）；随后补充 Codex 迟到回执/不支持协议、Claude 后续消息完成前不释放运行的 3 项回归，专项目标共 11 项通过。类型检查与构建通过。所有代码仍在独立 worktree，未提交、推送或安装。
