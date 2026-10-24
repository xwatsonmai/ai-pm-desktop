import type { PlanView, TaskView } from '../shared/api.js'

export const STAGE_LABEL: Record<string, string> = {
  plan: '方案', develop: '开发', review: '评审', test_release: '提测', release: '上线', collab: '协同',
}

export const STATUS_LABEL: Record<string, string> = {
  queued: '排队中', running: '运行中', needs_you: '待你处理', waiting: '等待中', done: '已完成', closed: '已关闭',
}

export const REASON_LABEL: Record<string, string> = {
  plan_confirm: '方案待确认', agent_question: 'Agent 提问', ready_to_test: '待提测', ready_to_release: '待上线',
  release_failed: '发布未完成', output_invalid: '结果格式不合格', executor_failing: '执行器连续失败',
  platform_rejected: '平台拒绝了操作', merge_failed: '修复合入失败', taken_over: '已接管',
  syncing: '同步平台中', aligning: '等产品回复', testing: '产品测试中', acceptance: '待验收', in_batch: '发布中',
}

export const PLATFORM_LABEL: Record<string, string> = {
  ready: '待认领', doing: '处理中', aligning: '对齐中', testing: '测试中', fixing: '修复中', retest: '待复测', verifying: '待验证',
  resolved: '已解决', pending_release: '待上线', review: '待验收', done: '已验收', completed: '已完成', canceled: '已取消',
  cancelled: '已取消', closed: '已关闭', rejected: '已拒绝', pending: '待认领', investigating: '排查中',
}

export const platformLabel = (status: string | null | undefined) => (status ? PLATFORM_LABEL[status] ?? status : '—')

export const KIND_LABEL: Record<string, string> = { task: '需求', collaboration: '协同', batch: '发布批次' }

export const EVENT_LABEL: Record<string, string> = {
  claiming: '认领', platform_ok: '平台已确认', platform_retry: '平台重试', platform_rejected: '平台拒绝',
  run_started: '开始执行', run_interrupted: '执行中断', output_invalid: '结果不合格', needs_you: '等你处理',
  retry: '稍后重试', error: '错误', back_to_plan: '回到方案', batch_created: '创建发布', batch_done: '发布完成',
  merge_conflict: '合入冲突', bug_returned: 'Bug 被退回',
}

// The order of groups on the "待你处理" page: things blocking work first.
export const NEEDS_ORDER = [
  'plan_confirm', 'agent_question', 'merge_failed', 'release_failed', 'platform_rejected', 'output_invalid', 'executor_failing',
  'ready_to_test', 'ready_to_release', 'taken_over',
]

export function groupNeeds(tasks: TaskView[]) {
  const needs = tasks.filter((t) => t.status === 'needs_you')
  return NEEDS_ORDER.map((reason) => ({ reason, title: REASON_LABEL[reason], tasks: needs.filter((t) => t.reason === reason) }))
    .filter((group) => group.tasks.length > 0)
}

export function stateLabel(task: TaskView): string {
  const reason = task.reason ? REASON_LABEL[task.reason] ?? task.reason : null
  if (task.status === 'needs_you' && reason) return reason
  if (task.status === 'waiting' && reason) return reason
  return STATUS_LABEL[task.status] ?? task.status
}

export type Tone = 'accent' | 'warn' | 'danger' | 'ok' | 'muted' | 'info'

export function stateTone(task: TaskView): Tone {
  if (task.status === 'needs_you') {
    return ['release_failed', 'platform_rejected', 'output_invalid', 'executor_failing', 'merge_failed'].includes(task.reason ?? '') ? 'danger' : 'warn'
  }
  if (task.status === 'running') return 'accent'
  if (task.status === 'done') return 'ok'
  if (task.status === 'closed') return 'muted'
  return 'info'
}

export type Answers = Record<string, string | string[]>

export function missingAnswers(plan: PlanView | null, answers: Answers): string[] {
  return (plan?.business_questions ?? []).filter((q) => {
    if (!q.required) return false
    const answer = answers[q.id]
    return answer === undefined || (Array.isArray(answer) ? answer.length === 0 : !answer.trim())
  }).map((q) => q.title)
}

export const shortSha = (sha?: string | null) => (sha ? sha.slice(0, 10) : '')

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86400)} 天前`
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
