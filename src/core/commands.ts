import { randomUUID } from 'node:crypto'
import type { Scheduler } from './scheduler.js'
import { now, type Store } from './store.js'
import { executorLabel } from '../shared/labels.js'
import type { ExecutorName, NeedsReason, ReviewItem, Settings, Task } from './types.js'
import { headSha } from './workspace.js'

export class CommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

// Everything a user can do from the UI. Each command checks the task is in the
// state the button belongs to, then moves it on; the engine does the rest.
export class Commands {
  constructor(
    private readonly store: Store,
    private readonly scheduler: Scheduler,
    private readonly settings: () => Settings,
  ) {}

  private expect(key: string, reasons: NeedsReason[]): Task {
    const task = this.store.getTask(key)
    if (!task) throw new CommandError('not_found', '找不到任务 ' + key)
    if (task.status !== 'needs_you' || !reasons.includes(task.reason as NeedsReason)) {
      throw new CommandError('wrong_state', `任务当前是 ${task.status}${task.reason ? '/' + task.reason : ''}，不能执行这个操作`)
    }
    return task
  }

  private feedback(task: Task, source: string, text: string) {
    task.data.feedback = [...(task.data.feedback ?? []), { at: now(), source, text }]
  }

  // What the user did and said, kept on the task's timeline next to what the
  // agent and the platform did.
  private you(key: string, text: string) {
    this.store.event(key, 'you', text)
  }

  async confirmPlan(key: string, answers: Record<string, string | string[]> = {}) {
    const task = this.expect(key, ['plan_confirm'])
    const questions = ((task.data.plan as any)?.business_questions ?? []) as any[]
    const missing = questions.filter((q) => {
      const answer = answers[q.id]
      return q.required && (answer === undefined || (Array.isArray(answer) ? answer.length === 0 : !String(answer).trim()))
    })
    if (missing.length) throw new CommandError('answers_required', '还有必填问题没有回答：' + missing.map((q) => q.title).join('、'))
    this.store.tx(() => {
      this.store.updateTask(key, (t) => {
        t.data.planApproval = { plan: t.data.plan, answers, revision: t.revision, at: now() }
        t.stage = 'develop'
        t.status = 'queued'
        t.reason = null
        t.detail = null
        t.data.next = { purpose: 'start' }
      })
      this.scheduler.write(task, 'task_report_work', {
        task_id: task.platformId, claim_id: task.claimId, report_kind: 'progress', body: '方案已确认，开始开发。',
      }, 'none')
    })
    const choices = questions.filter((q) => answers[q.id] !== undefined && String(answers[q.id]).trim()).map((q) => {
      const picked = (Array.isArray(answers[q.id]) ? answers[q.id] as string[] : [answers[q.id] as string])
        .map((id) => q.options?.find((o: any) => o.id === id)?.label ?? id)
      return `${q.title} → ${picked.join('、')}`
    })
    this.you(key, ['确认了方案，开始开发', ...choices].join('；'))
  }

  async revisePlan(key: string, text: string) {
    this.expect(key, ['plan_confirm'])
    this.store.updateTask(key, (t) => {
      this.feedback(t, '方案意见', text)
      t.status = 'queued'
      t.reason = null
      t.data.next = { purpose: 'continue', message: `用户对方案的意见：${text}\n请据此修订方案。` }
    })
    this.you(key, '驳回方案，要求修订：' + text)
  }

  async answer(key: string, text: string) {
    this.expect(key, ['agent_question', 'merge_failed'])
    this.store.updateTask(key, (t) => {
      this.feedback(t, '用户回复', text)
      t.status = 'queued'
      t.reason = null
      t.data.next = { purpose: 'continue', message: `用户回复：${text}` }
    })
    this.you(key, '回复 Agent：' + text)
  }

  async requestChanges(key: string, text: string) {
    this.expect(key, ['ready_to_test'])
    this.store.updateTask(key, (t) => {
      this.feedback(t, '修改意见', text)
      t.stage = 'develop'
      t.status = 'queued'
      t.reason = null
      t.data.next = { purpose: 'continue', message: `用户要求修改：${text}` }
    })
    this.you(key, '要求再改：' + text)
  }

  // ---- AI review: chosen instead of 提测, run on the executor the user picks ----

  async startReview(key: string, executor: ExecutorName) {
    const task = this.expect(key, ['ready_to_test'])
    if (!this.settings().executors[executor]?.binary) throw new CommandError('executor_not_configured', `还没有配置 ${executorLabel(executor)}`)
    const last = task.data.reviews?.at(-1)
    // The same reviewer rechecks in its own session; another one starts fresh with the history in review.json.
    const same = task.data.reviewer === executor && !!task.sessions.review
    let message: string | undefined
    if (same && last) {
      const head = task.worktree ? await headSha(task.worktree) : ''
      message = [
        `用户再次发起评审。当前提交是 ${head}，上一轮评审的是 ${last.sha}。`,
        last.decision?.kind === 'fix' ? '开发已经按上一轮确认的修复名单修改：先复查这些条目是否修好，再检查新的改动有没有引入问题。' : '',
        '评审范围和历史见 .ai-pm/review.json。',
      ].filter(Boolean).join('\n')
    }
    this.store.updateTask(key, (t) => {
      t.stage = 'review'
      t.status = 'queued'
      t.reason = null
      t.detail = null
      if (!same) delete t.sessions.review
      t.data.reviewer = executor
      t.data.next = same ? { purpose: 'continue', message } : { purpose: 'start' }
    })
    this.you(key, `发起 AI 评审（${executorLabel(executor)}）`)
  }

  // The ticked items go back to the development session as the fixes to make.
  async applyReview(key: string, itemIds: string[], note = '') {
    const task = this.expect(key, ['review_ready'])
    const review = task.data.reviews!.at(-1)!
    const chosen = review.items.filter((item) => itemIds.includes(item.id))
    if (!chosen.length) throw new CommandError('nothing_chosen', '请至少勾选一条要修的问题')
    const message = [
      `AI 评审（第 ${review.round} 轮，${executorLabel(review.executor)}）发现以下问题，用户确认需要修复：`,
      ...chosen.map(fixLine),
      review.fixPlan.trim() ? '评审给出的修复方案：\n' + review.fixPlan.trim() : '',
      note.trim() ? '用户补充：' + note.trim() : '',
      '按这些修改并补充或更新测试，提交到当前分支。没有勾选的条目不用修。',
    ].filter(Boolean).join('\n')
    this.store.updateTask(key, (t) => {
      this.feedback(t, 'AI 评审', message)
      t.data.reviews!.at(-1)!.decision = { kind: 'fix', at: now(), items: chosen.map((i) => i.id), ...(note.trim() ? { note: note.trim() } : {}) }
      t.stage = 'develop'
      t.status = 'queued'
      t.reason = null
      t.data.next = { purpose: 'continue', message }
    })
    this.you(key, `确认评审意见，返回开发修复 ${chosen.length} 条：${chosen.map((i) => i.id).join('、')}` + (note.trim() ? '；' + note.trim() : ''))
  }

  // The user disagrees with part of the review: the same reviewer looks again with their notes.
  async rereview(key: string, note: string) {
    this.expect(key, ['review_ready'])
    if (!note.trim()) throw new CommandError('note_required', '请写下你的意见')
    this.store.updateTask(key, (t) => {
      t.data.reviews!.at(-1)!.decision = { kind: 'rereview', at: now(), note: note.trim() }
      t.status = 'queued'
      t.reason = null
      t.data.next = { purpose: 'continue', message: `用户对上一轮评审的意见：${note.trim()}\n结合这些意见重新评审当前提交，评审范围和历史见 .ai-pm/review.json。` }
    })
    this.you(key, '补充意见后重新评审：' + note.trim())
  }

  // Nothing to fix, or nothing worth fixing: on to the test release.
  async skipReview(key: string) {
    this.expect(key, ['review_ready'])
    this.store.updateTask(key, (t) => {
      t.data.reviews!.at(-1)!.decision = { kind: 'skip', at: now() }
      t.stage = 'develop'
      t.status = 'needs_you'
      t.reason = 'ready_to_test'
      t.detail = t.data.dev?.summary ?? null
    })
    this.you(key, '评审后不修改，直接提测')
    return this.submitTest([key])
  }

  private createBatch(keys: string[], stage: 'test_release' | 'release', reason: NeedsReason): string {
    if (!keys.length) throw new CommandError('empty', '请至少选择一个需求')
    const members = keys.map((key) => this.expect(key, [reason]))
    const settings = this.settings()
    const instructions = stage === 'test_release' ? settings.testReleaseInstructions : settings.releaseInstructions
    if (!instructions?.trim()) {
      throw new CommandError('instructions_required', stage === 'test_release' ? '请先填写测试发布说明' : '请先填写上线发布说明')
    }
    const id = randomUUID()
    const key = 'batch:' + id
    const stamp = now()
    const first = members[0]
    this.store.tx(() => {
      this.store.saveTask({
        key, kind: 'batch', platformId: id, title: `${stage === 'test_release' ? '提测' : '上线'} · ${members.length === 1 ? first.title : members.length + ' 个需求'}`,
        stage, status: 'queued', reason: null, detail: null, executor: first.executor, models: structuredClone(first.models),
        claimId: null, revision: null, version: null, platformStatus: null, branch: null, worktree: null, sessions: {},
        data: { members: keys, next: { purpose: 'start' } }, retryAt: null, failures: 0, lastError: null, createdAt: stamp, updatedAt: stamp,
      })
      for (const member of members) {
        this.store.updateTask(member.key, (t) => {
          t.stage = stage
          t.status = 'waiting'
          t.reason = 'in_batch'
          t.data.batch = key
        })
      }
      this.store.event(key, 'batch_created', keys.join(', '))
      const what = stage === 'test_release' ? '点了提测' : '点了上线'
      for (const member of members) this.you(member.key, members.length > 1 ? `${what}（和另外 ${members.length - 1} 个需求一起）` : what)
    })
    return key
  }

  async submitTest(keys: string[]) {
    return this.createBatch(keys, 'test_release', 'ready_to_test')
  }

  async release(keys: string[]) {
    return this.createBatch(keys, 'release', 'ready_to_release')
  }

  // Continuing after a stopped release means the user read what the agent
  // reported and accepts it; without saying so the agent would stop on the
  // same check again.
  async continueRelease(batchKey: string, note?: string) {
    const batch = this.expect(batchKey, ['release_failed'])
    const previous = (batch.data.release ?? {}) as Record<string, any>
    const reported = [previous.summary, previous.limitations].filter((x) => typeof x === 'string' && x.trim()).join('\n')
    const message = [
      '用户看过你上一轮的发布结果，决定继续发布。',
      reported ? `你上一轮报告的情况：\n${reported}` : '',
      '这些已经报告过的问题，用户确认可以接受，不要因为它们再停下。按发布说明完成剩下的步骤：已经完成的不要重复，推送、部署和验证照常进行。',
      '如果遇到上一轮没有报告过的新问题，仍然停下来说明。',
      note?.trim() ? `用户补充：${note.trim()}` : '',
    ].filter(Boolean).join('\n')
    this.store.updateTask(batchKey, (t) => {
      t.status = 'queued'
      t.reason = null
      t.data.next = { purpose: t.sessions[t.stage] ? 'continue' : 'start', message }
    })
    for (const key of [batchKey, ...(batch.data.members ?? [])]) {
      this.you(key, '继续发布：接受上一轮报告的问题' + (note?.trim() ? '；' + note.trim() : ''))
    }
  }

  // The user confirms by hand that the release is done; registration then proceeds as usual.
  async markReleased(batchKey: string, note: string) {
    const batch = this.expect(batchKey, ['release_failed'])
    if (!note.trim()) throw new CommandError('note_required', '请写一句说明')
    const previous = (batch.data.release ?? {}) as Record<string, any>
    const members = (batch.data.members ?? []).map((key) => this.store.getTask(key)).filter((t): t is Task => !!t)
    for (const key of [batchKey, ...(batch.data.members ?? [])]) this.you(key, '人工确认发布已完成：' + note)
    this.scheduler.completeBatch(batch, {
      outcome: 'success', summary: '用户确认发布已完成：' + note, verification: note,
      environment: previous.environment || (batch.stage === 'test_release' ? '测试环境' : '生产环境'),
      deployed_sha: previous.deployed_sha ?? '',
    }, members)
  }

  private endBatch(batchKey: string, memberUpdate: (t: Task) => void) {
    const batch = this.expect(batchKey, ['release_failed'])
    this.store.tx(() => {
      for (const key of batch.data.members ?? []) this.store.updateTask(key, (t) => {
        t.data.batch = null
        memberUpdate(t)
      })
      this.store.updateTask(batchKey, (t) => {
        t.status = 'closed'
        t.reason = null
      })
    })
    return batch
  }

  async abandonBatch(batchKey: string) {
    const batch = this.store.getTask(batchKey)
    this.endBatch(batchKey, (t) => {
      this.you(t.key, '放弃了这次发布')
      t.status = 'needs_you'
      t.reason = batch?.stage === 'release' ? 'ready_to_release' : 'ready_to_test'
      if (t.reason === 'ready_to_test') t.stage = 'develop'
    })
  }

  async sendBackToDev(batchKey: string, text: string) {
    const batch = this.store.getTask(batchKey)
    if (batch?.stage === 'release') throw new CommandError('use_rework', '上线阶段请对单个需求使用“退回开发”')
    this.endBatch(batchKey, (t) => {
      this.you(t.key, '发布没成功，交给开发修复：' + text)
      this.feedback(t, '发布问题', text)
      t.stage = 'develop'
      t.status = 'queued'
      t.reason = null
      t.data.next = { purpose: 'continue', message: `提测发布没有成功，需要你修复：${text}` }
    })
  }

  async retry(key: string, executor?: ExecutorName) {
    const task = this.expect(key, ['output_invalid', 'executor_failing', 'platform_rejected'])
    const current = task.stage === 'review' ? task.data.reviewer ?? task.executor : task.executor
    const target = executor ?? current
    const configured = this.settings().executors[target]
    if (executor !== undefined && (!['codex', 'claude', 'zcode'].includes(executor) || !configured?.binary?.trim() || !(configured.limit >= 1))) {
      throw new CommandError('executor_unavailable', '请先在设置中配置目标执行器及运行名额')
    }
    if (task.reason === 'platform_rejected' && target !== current) throw new CommandError('wrong_state', '平台操作重试不更换执行器，请先处理平台拒绝')
    if (task.reason === 'platform_rejected') {
      const rejected = task.data.rejected
      const item = rejected && this.store.getOutbox(rejected.outboxId)
      if (!item) throw new CommandError('nothing_to_retry', '找不到被拒绝的操作')
      await this.scheduler.refreshTask(task).catch(() => {})
      const fresh = this.store.getTask(key)!
      const { request_id: _old, ...params } = item.params
      for (const field of ['version', 'revision', 'claim_id'] as const) {
        const value = field === 'claim_id' ? fresh.claimId : fresh[field]
        if (field in params && value != null) params[field] = value
      }
      this.store.tx(() => {
        this.store.updateTask(key, (t) => {
          t.data.rejected = null
        })
        this.scheduler.write(fresh, item.tool, params, item.effect, item.effectArgs)
      })
      this.you(key, '用最新数据重试被平台拒绝的操作')
      return
    }
    if (this.store.openRuns().some((r) => r.taskKey === key)) throw new CommandError('run_active', '仍有未结束的执行轮次，不能重新派发')
    if (target !== current) {
      const message = `用户将任务从 ${executorLabel(current)} 交给 ${executorLabel(target)} 重试。请先阅读 .ai-pm/ 中的需求、方案和反馈，检查当前工作区及 Git 改动后继续，不要覆盖已有成果或重复已完成的提交、合并、部署和平台操作。`
      this.store.tx(() => {
        this.store.updateTask(key, (t) => {
          if (t.stage === 'review') {
            t.data.reviewer = target
            delete t.sessions.review
          } else {
            t.executor = target
            t.models = structuredClone(configured?.models ?? {})
            t.sessions = {} // session ids belong to the old executor; runs retain history
          }
          this.feedback(t, '执行器交接', message)
          t.data.interruptions = 0
          t.data.repairs = 0
          t.failures = 0
          t.lastError = null
          t.retryAt = null
          t.status = 'queued'
          t.reason = null
          t.detail = null
          t.data.next = { purpose: 'start', schema: t.data.next?.schema, message }
        })
        this.you(key, `更换执行器并重试：${executorLabel(current)} → ${executorLabel(target)}`)
      })
      return
    }
    this.store.updateTask(key, (t) => {
      if (executor && t.stage !== 'review') t.models = structuredClone(configured?.models ?? {})
      t.status = 'queued'
      t.reason = null
      if (task.reason === 'output_invalid') {
        t.data.repairs = 0
        t.data.next = { ...(t.data.next ?? { purpose: 'repair' }), purpose: 'repair', message: '请重新检查并输出符合要求的结果 JSON。' }
      } else {
        t.data.interruptions = 0
        t.data.next = { ...(t.data.next ?? { purpose: 'resume' }), purpose: 'resume' }
      }
    })
    this.you(key, '重试')
  }

  async takeOver(key: string) {
    const task = this.store.getTask(key)
    if (!task || task.status === 'done' || task.status === 'closed') throw new CommandError('wrong_state', '任务已经结束')
    await this.scheduler.killRun(key)
    this.store.updateTask(key, (t) => {
      t.data.takenOver = { stage: t.stage, status: t.status }
      t.status = 'needs_you'
      t.reason = 'taken_over'
      t.detail = '你已接管这个任务，自动化已暂停。'
    })
    this.you(key, '接管了任务，自动化暂停')
  }

  async handBack(key: string) {
    this.expect(key, ['taken_over'])
    this.store.updateTask(key, (t) => {
      t.status = 'queued'
      t.reason = null
      t.detail = null
      t.data.takenOver = null
      t.data.next = { purpose: 'continue', message: '用户手动处理过这个任务。先检查工作区和当前状态，再继续。' }
    })
    this.you(key, '交还自动化')
  }

  async rework(key: string, reason: string) {
    const task = this.expect(key, ['ready_to_release'])
    this.scheduler.write(task, 'task_rework', { task_id: task.platformId, claim_id: task.claimId, body: reason }, 'reworked', {
      message: `上线前被退回：${reason}`,
    })
    this.you(key, '上线前退回开发：' + reason)
  }

  async releaseClaim(key: string, note: string) {
    const task = this.store.getTask(key)
    if (!task || task.kind === 'batch') throw new CommandError('not_found', '找不到任务')
    await this.scheduler.killRun(key)
    if (task.kind === 'task') {
      this.scheduler.write(task, 'task_release', { task_id: task.platformId, claim_id: task.claimId, body: note }, 'released')
    } else {
      this.scheduler.write(task, 'collaboration_release', { collaboration_id: task.platformId, claim_id: task.claimId, body: note }, 'released')
    }
    this.you(key, '放弃认领：' + note)
  }

  async closeRequirement(key: string, instruction: string, decline = false) {
    const task = this.store.getTask(key)
    if (!task || task.kind !== 'task') throw new CommandError('not_found', '找不到需求')
    if (!instruction.trim()) throw new CommandError('instruction_required', '请填写原因')
    await this.scheduler.killRun(key)
    await this.scheduler.refreshTask(task).catch(() => {})
    const fresh = this.store.getTask(key)!
    this.scheduler.write(fresh, decline ? 'task_decline' : 'task_close', {
      task_id: fresh.platformId, version: fresh.version, body: instruction, user_confirmed: true, user_instruction: instruction,
    }, 'closed')
    this.you(key, (decline ? '拒绝需求：' : '关闭需求：') + instruction)
  }

  async retryNow(key: string) {
    this.store.updateTask(key, (t) => {
      t.retryAt = null
    })
    this.you(key, '立即重试')
  }

  // Deletes a finished task's checkouts now rather than after the retention
  // period: its own, and those of releases made for it alone. Uncommitted
  // changes stop it unless the user chose to discard them.
  async removeWorkspace(key: string, discardChanges = false) {
    const task = this.store.getTask(key)
    if (!task) throw new CommandError('not_found', '找不到任务 ' + key)
    if (!['done', 'closed'].includes(task.status)) throw new CommandError('wrong_state', '任务结束后才能删除工作区')
    const targets = [task, ...this.ownReleases(key)]
    if (!discardChanges) {
      for (const target of targets) {
        const changes = await this.scheduler.checkoutChanges(target)
        if (changes?.length) throw new CommandError('workspace_dirty', `工作区有未提交的改动：${changes.slice(0, 5).join('、')}${changes.length > 5 ? ` 等 ${changes.length} 个文件` : ''}`)
      }
    }
    for (const target of targets) await this.scheduler.removeCheckout(target, discardChanges)
    await this.scheduler.pruneWorktrees()
    this.you(key, discardChanges ? '删除了工作区，丢弃了未提交的改动' : '删除了工作区')
  }

  // Finished release batches that held only this task.
  private ownReleases(key: string): Task[] {
    return this.store.listTasks({ kind: ['batch'], status: ['done', 'closed'] })
      .filter((b) => b.data.members?.length === 1 && b.data.members[0] === key)
  }
}

const SEVERITY: Record<ReviewItem['severity'], string> = { must: '必须修', should: '建议修', optional: '可选' }

function fixLine(item: ReviewItem): string {
  return `- [${item.id}][${SEVERITY[item.severity]}] ${item.title}（${item.location}）\n  问题：${item.problem}\n  改法：${item.suggestion}`
}
