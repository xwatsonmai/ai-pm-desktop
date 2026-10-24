import { randomUUID } from 'node:crypto'
import type { Scheduler } from './scheduler.js'
import { now, type Store } from './store.js'
import type { NeedsReason, Settings, Task } from './types.js'

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
        key, kind: 'batch', platformId: id, title: `${stage === 'test_release' ? '提测' : '上线'} · ${members.length} 个需求`,
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

  async continueRelease(batchKey: string, note?: string) {
    this.expect(batchKey, ['release_failed'])
    this.store.updateTask(batchKey, (t) => {
      t.status = 'queued'
      t.reason = null
      t.data.next = { purpose: t.sessions[t.stage] ? 'continue' : 'start', message: note ? `用户补充：${note}` : '继续完成没有完成的发布步骤。' }
    })
    this.you(batchKey, '继续发布' + (note ? '：' + note : ''))
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

  async retry(key: string) {
    const task = this.expect(key, ['output_invalid', 'executor_failing', 'platform_rejected'])
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
    this.store.updateTask(key, (t) => {
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
}
