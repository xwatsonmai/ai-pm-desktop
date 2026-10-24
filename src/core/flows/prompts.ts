import type { RunPurpose, Stage, Task } from '../types.js'

// Prompts stay short: the facts live in .ai-pm/ files, and agents never talk to
// the platform. The first line is a stable marker for logs and the test CLI.
const marker = (stage: Stage, purpose: RunPurpose, task: Task) => `[ai-pm stage=${stage} purpose=${purpose} task=${task.platformId}]`

const NO_PLATFORM = '不要访问 AI PM 平台，也不要尝试认领、提交或登记；平台上的操作都由客户端完成。'
const JSON_ONLY = '最后只输出符合 schema 的 JSON 对象。不适用的字段填空字符串或空数组。'

export function planPrompt(task: Task, purpose: RunPurpose, message?: string): string {
  const head = marker('plan', purpose, task)
  if (purpose === 'start') {
    return [
      head,
      `你在为一个需求做开发前的方案分析：${task.title}`,
      '本轮只读：不要修改文件，不要提交代码。当前目录是这个需求专用的 git worktree。',
      '需求资料在 .ai-pm/task.json，包括需求、验收条件、修订号和附件。',
      '要求：',
      '- 自己阅读代码、数据库迁移、测试和 Git 历史，查清技术事实。技术结论写进 technical_findings，并附可核对的依据。',
      '- business_questions 只放必须由用户决定的业务规则、范围、预期行为或验收标准。用非技术语言，选项写清影响，给出推荐项。没有业务分歧就返回空数组。',
      '- 不要问用户表、字段、接口在哪里这类可以自己查到的技术问题。',
      '- summary 用简短的业务语言；plan 写实现步骤；tests 写验证方法；risks 写风险。',
      NO_PLATFORM,
      JSON_ONLY,
    ].join('\n')
  }
  return [head, message ?? '', '仍然只读。输出完整的新方案 JSON。'].join('\n')
}

export function developPrompt(task: Task, purpose: RunPurpose, message?: string): string {
  const head = marker('develop', purpose, task)
  if (purpose === 'start') {
    return [
      head,
      `你在为一个需求写代码：${task.title}`,
      `当前目录是这个需求专用的 git worktree，分支 ${task.branch}。不要切换分支，不要改动这个目录以外的文件。`,
      '资料：',
      '- .ai-pm/task.json：需求、验收条件、修订号。',
      '- .ai-pm/plan.json：用户已确认的方案和业务选择，按它实现。',
      '- .ai-pm/feedback.md：之后的评审意见、用户意见和产品回复（如果有）。',
      '要求：',
      '- 实现并自测。测试命令和结果如实写进 tests，没跑的写进 limitations。',
      '- 完成后把改动提交到当前分支，只提交本需求相关的文件，工作区保持干净。不要推送、合并或部署。',
      '- status 的含义：done 表示已完成并提交，sha 填 HEAD 的完整 SHA；needs_alignment 表示有需要产品确认的业务问题，写进 alignment_questions，message 写背景；needs_user 表示需要用户提供非产品类的信息（环境、账号、技术取舍），写进 message；blocked 表示无法继续，原因写进 message。',
      NO_PLATFORM,
      JSON_ONLY,
    ].join('\n')
  }
  if (purpose === 'alignment') {
    return [
      head,
      '产品已回复你之前提出的问题，最新回复在 .ai-pm/task.json 的 task.alignment 字段。',
      '判断信息是否足够：足够就 decision=resume，body 写你的理解和接下来的做法；仍有疑问就 decision=ask_again，把问题写进 questions，body 写背景。',
      '本轮不要修改代码。',
      JSON_ONLY,
    ].join('\n')
  }
  return [head, message ?? '', '在当前工作区继续。完成后按同样的格式输出结果 JSON。'].join('\n')
}

export function releasePrompt(task: Task, stage: 'test_release' | 'release', purpose: RunPurpose, message?: string): string {
  const head = marker(stage, purpose, task)
  const where = stage === 'test_release' ? '测试环境' : '生产环境'
  if (purpose === 'start') {
    return [
      head,
      `你负责把一批已经开发完成的需求发布到${where}。当前目录是独立的发布工作区。`,
      '.ai-pm/release.json 里有发布说明原文，以及本批需求的任务 ID、分支、开发提交 SHA 和摘要。',
      '要求：',
      '- 严格按发布说明执行：是否合并、合并到哪个分支、怎么构建、部署和验证，都按说明判断。说明不清楚或超出授权时停下，outcome=failed，并在 summary 写清楚原因。',
      '- outcome：全部按说明发布并验证成功为 success；只完成一部分为 partial；没有完成为 failed。',
      '- deployed_sha 填实际部署的提交；items 逐个列出每个需求是否包含在本次发布里。',
      NO_PLATFORM,
      JSON_ONLY,
    ].join('\n')
  }
  return [head, message ?? '', '先确认环境里当前已部署的版本，不要重复执行已经完成的步骤。完成后按同样的格式输出结果 JSON。'].join('\n')
}

export function collabPrompt(task: Task, purpose: RunPurpose, message?: string): string {
  const head = marker('collab', purpose, task)
  if (purpose === 'start') {
    return [
      head,
      `你在处理一个只读排查任务：${task.title}`,
      '任务内容在 .ai-pm/task.json。本轮只读：不要修改文件，也不要对任何环境做写操作。',
      '按任务要求查证，结论写进 summary，依据写进 evidence，查不到的写进 limitations。',
      '- outcome：查实为 confirmed，必须附 evidence；查过但没有结论为 inconclusive；没有权限或访问不到环境为 cannot_access。',
      '- environment、observed_at（含时区）、deployment_version 写实际核查的环境、取证时间和部署版本，不知道就写"未知"；limitations 没有也写"无"。',
      NO_PLATFORM,
      JSON_ONLY,
    ].join('\n')
  }
  return [head, message ?? '', '仍然只读。完成后输出结果 JSON。'].join('\n')
}

export const RESUME_MESSAGE = '上一轮执行被中断了。先检查工作区和已经完成的步骤，不要重复已完成的操作，然后继续。'

export function repairMessage(error: string): string {
  return `你上一轮的结果不符合要求：${error}。如果需要，先修正工作区（例如提交未提交的改动），然后只输出修正后的 JSON。`
}

// Only what an agent needs about one requirement; never the whole project's lists.
export function trimContext(raw: any): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const keep = ['task', 'requirement_review', 'decisions', 'attachments', 'alignment', 'bug_context']
  const out: Record<string, unknown> = {}
  for (const key of keep) if (raw[key] !== undefined) out[key] = raw[key]
  if (Array.isArray(raw.events)) out.events = raw.events.slice(-20)
  if (!raw.task && raw.id) return raw // collaboration_get returns the item itself
  return out
}
