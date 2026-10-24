import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Executor } from './executors/types.js'
import { collabPrompt, developPrompt, planPrompt, releasePrompt, repairMessage, RESUME_MESSAGE, trimContext } from './flows/prompts.js'
import { schemas, type SchemaName } from './flows/schemas.js'
import { validateResult } from './flows/validate.js'
import { PlatformError, type Platform } from './platform/client.js'
import { contractProblem } from './platform/contract.js'
import { alignmentRequest } from './platform/format.js'
import { backoff, type Outbox, type OutboxHandlers } from './platform/outbox.js'
import { now, type OutboxRow, type RunRow, type Store } from './store.js'
import type { DevResult, ExecutorName, NeedsReason, NextRun, RunPurpose, Settings, Stage, Task, Timing, WaitReason } from './types.js'
import { ensureDetachedWorktree, ensureTaskWorktree, headSha, integrateInto, isClean, originUrl, repoPrefix, repositoryIdentity, writeContext, type Integration } from './workspace.js'

export interface SchedulerDeps {
  store: Store
  platform: Platform
  outbox: Outbox
  executors: Partial<Record<ExecutorName, Executor>>
  settings: () => Settings
  timing: () => Timing
  dataDir: string
  clock?: () => number
  onNeedsYou?: (task: Task) => void
}

const OPEN = ['queued', 'running', 'needs_you', 'waiting'] as const
const PLATFORM_CLOSED = new Set(['canceled', 'cancelled', 'closed', 'rejected'])
const MAX_INTERRUPTIONS = 3
const MAX_REPAIRS = 2
const CONTRACT_RECHECK_MS = 10 * 60_000

export class BindingError extends Error {}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// A bug the product filed against a requirement it was testing. Its fix ships
// as part of that requirement, never on its own.
function linkedBug(task: Task): { branch: string } | null {
  const remote = (task.data.context as any)?.task
  return remote?.parent_requirement_id ? { branch: String(remote.bug_context?.branch ?? '') } : null
}

export class Scheduler {
  health: Partial<Record<ExecutorName, boolean>> = {}
  private bindingCheckedAt = 0
  // Set while the platform does not speak the error-code contract; intake stays off.
  contractError: string | null = null
  private contractCheckedAt = 0
  private prefix: { repoPath: string; value: string } | null = null
  private readonly clock: () => number

  constructor(private readonly d: SchedulerDeps) {
    this.clock = d.clock ?? Date.now
  }

  private get store() {
    return this.d.store
  }

  // ---------------- tick: local work only ----------------

  async tick(): Promise<void> {
    await this.pollRuns()
    await this.startQueued()
    this.renewCollaborationLeases()
    await this.d.outbox.flush(this.outboxHandlers)
  }

  private executor(name: ExecutorName): Executor {
    const executor = this.d.executors[name]
    if (!executor) throw new Error('executor_not_configured: ' + name)
    return executor
  }

  private async pollRuns() {
    for (const run of this.store.openRuns()) {
      try {
        const result = this.executor(run.executor).poll(run)
        if (result.sessionId && result.sessionId !== run.sessionId) {
          this.store.setRunSession(run.id, result.sessionId)
          this.store.updateTask(run.taskKey, (t) => {
            t.sessions[run.stage] = result.sessionId
          })
          run.sessionId = result.sessionId
        }
        if (result.done) await this.finishRun(run, result.outcome)
      } catch (error) {
        this.noteError(run.taskKey, error)
      }
    }
  }

  private runningCount(executor: ExecutorName): number {
    return this.store.listTasks({ status: ['running'] }).filter((t) => t.executor === executor).length
  }

  private hasCapacity(task: Task): boolean {
    const limit = this.d.settings().executors[task.executor]?.limit ?? 0
    if (this.runningCount(task.executor) >= limit) return false
    // Release lock: one test release and one production release at a time.
    if (task.kind === 'batch') {
      return !this.store.listTasks({ status: ['running'], kind: ['batch'] }).some((t) => t.stage === task.stage)
    }
    return true
  }

  private async startQueued() {
    for (const task of this.store.listTasks({ status: ['queued'] })) {
      if (task.retryAt && task.retryAt > this.clock()) continue
      if (!this.hasCapacity(task)) continue
      try {
        await this.startStage(task)
      } catch (error) {
        this.retryLater(task.key, error)
      }
    }
  }

  private schemaFor(stage: Stage, next: NextRun): SchemaName {
    if (next.schema) return next.schema
    if (next.purpose === 'alignment') return 'alignment'
    if (stage === 'test_release' || stage === 'release') return 'release'
    return stage as SchemaName
  }

  private async startStage(task: Task) {
    const settings = this.d.settings()
    const next: NextRun = task.data.next ?? { purpose: 'start' }
    let purpose: RunPurpose = next.purpose
    let sessionId = task.sessions[task.stage]
    if (purpose !== 'start' && !sessionId) purpose = 'start' // e.g. crashed before the session was created
    if (purpose === 'start') sessionId = undefined
    if (purpose === 'resume') next.message = RESUME_MESSAGE
    const schemaName = this.schemaFor(task.stage, { ...next, purpose: next.purpose })
    const models = task.models
    let cwd: string
    let readOnly = false
    let model = models.execution
    let prompt: string

    if (task.kind !== 'batch') await this.refreshTask(task)
    const fresh = this.store.getTask(task.key)!
    switch (task.stage) {
      case 'plan':
        cwd = await this.agentDir(await this.ensureWorktree(fresh))
        this.writeTaskFiles(fresh, cwd)
        readOnly = true
        model = models.expert
        prompt = planPrompt(fresh, purpose, next.message)
        break
      case 'develop':
        cwd = await this.agentDir(await this.ensureWorktree(fresh))
        this.writeTaskFiles(fresh, cwd)
        readOnly = schemaName === 'alignment'
        prompt = developPrompt(fresh, schemaName === 'alignment' && purpose !== 'repair' ? 'alignment' : purpose, next.message)
        break
      case 'test_release':
      case 'release': {
        const instructions = task.stage === 'test_release' ? settings.testReleaseInstructions : settings.releaseInstructions
        if (!instructions?.trim()) {
          this.needsYou(task.key, 'release_failed', task.stage === 'test_release' ? '还没有填写测试发布说明，请先在设置里填写。' : '还没有填写上线发布说明，请先在设置里填写。')
          return
        }
        cwd = await this.agentDir(await ensureDetachedWorktree({ repoPath: settings.repoPath, dir: join(this.d.dataDir, 'worktrees', 'b-' + task.platformId.slice(0, 8)), baseRef: settings.startRef }))
        this.writeReleaseFiles(fresh, cwd, instructions)
        prompt = releasePrompt(fresh, task.stage, purpose, next.message)
        break
      }
      case 'collab':
        cwd = await this.agentDir(await ensureDetachedWorktree({ repoPath: settings.repoPath, dir: join(this.d.dataDir, 'worktrees', 'c-' + task.platformId.slice(-8)), baseRef: settings.startRef }))
        this.writeTaskFiles(fresh, cwd)
        readOnly = true
        model = models.expert
        prompt = collabPrompt(fresh, purpose, next.message)
        break
      default:
        throw new Error('stage_not_supported: ' + task.stage)
    }

    const runId = randomUUID()
    const started = this.executor(task.executor).start({
      dir: join(this.d.dataDir, 'runs', runId), cwd, prompt, schema: schemas[schemaName], sessionId,
      model: model?.model, effort: model?.effort, readOnly,
    })
    this.store.tx(() => {
      this.store.insertRun({
        id: runId, taskKey: task.key, stage: task.stage, purpose, schemaName, executor: task.executor,
        sessionId: sessionId ?? null, pid: started.pid, pidStart: started.pidStart, logPath: started.logPath,
        outPath: started.outPath, startedAt: now(),
      })
      this.store.updateTask(task.key, (t) => {
        t.status = 'running'
        t.reason = null
        t.detail = null
        t.retryAt = null
        t.failures = 0
        t.lastError = null
        t.data.next = { ...next, purpose, schema: schemaName }
        if (task.kind === 'collaboration' && purpose === 'start') t.data.lastReportAt = this.clock()
      })
      this.store.event(task.key, 'run_started', `${task.stage} · ${purpose}`)
    })
  }

  private async ensureWorktree(task: Task): Promise<string> {
    if (task.worktree && existsSync(task.worktree)) return task.worktree
    const settings = this.d.settings()
    const context = task.data.context as any
    const baseRef = context?.task?.bug_context?.sha ?? settings.startRef
    const dir = join(this.d.dataDir, 'worktrees', 't-' + task.platformId.slice(-12))
    await ensureTaskWorktree({ repoPath: settings.repoPath, dir, branch: task.branch!, baseRef })
    this.store.updateTask(task.key, (t) => {
      t.worktree = dir
    })
    return dir
  }

  // Agents work in the same subdirectory of their checkout that repoPath points
  // to in the main checkout (for example <worktree>/server).
  private async agentDir(root: string): Promise<string> {
    const repoPath = this.d.settings().repoPath
    if (this.prefix?.repoPath !== repoPath) this.prefix = { repoPath, value: await repoPrefix(repoPath) }
    return this.prefix.value ? resolve(root, this.prefix.value) : root
  }

  private writeTaskFiles(task: Task, cwd: string) {
    const files: Record<string, string> = { 'task.json': JSON.stringify(task.data.context ?? {}, null, 2) }
    if (task.data.planApproval) files['plan.json'] = JSON.stringify(task.data.planApproval, null, 2)
    const feedback = task.data.feedback ?? []
    files['feedback.md'] = feedback.map((f) => `## ${f.at} · ${f.source}\n\n${f.text}\n`).join('\n')
    writeContext(cwd, files)
  }

  private writeReleaseFiles(batch: Task, cwd: string, instructions: string) {
    const members = (batch.data.members ?? []).map((key) => this.store.getTask(key)).filter((t): t is Task => !!t)
    writeContext(cwd, {
      'release.json': JSON.stringify({
        environment: batch.stage === 'test_release' ? '测试环境' : '生产环境',
        instructions,
        base_ref: this.d.settings().startRef,
        items: members.map((m) => ({
          task_id: m.platformId, title: m.title, branch: m.data.integratedInto ?? m.branch,
          sha: m.data.submittedSha ?? m.data.dev?.sha ?? '', summary: m.data.dev?.summary ?? '', tests: m.data.dev?.tests ?? '',
        })),
      }, null, 2),
    })
  }

  // ---------------- run results ----------------

  private async finishRun(run: RunRow, outcome: { kind: 'completed' | 'failed' | 'interrupted'; text?: string; error?: string }) {
    this.store.endRun(run.id, outcome.kind, outcome.text ?? null, outcome.error ?? null)
    const task = this.store.getTask(run.taskKey)
    if (!task || task.status !== 'running') return // closed or taken over meanwhile
    const next = task.data.next ?? { purpose: run.purpose }
    if (outcome.kind !== 'completed') {
      const interruptions = (task.data.interruptions ?? 0) + 1
      this.store.event(task.key, 'run_interrupted', outcome.error ?? outcome.kind)
      if (interruptions < MAX_INTERRUPTIONS) {
        this.store.updateTask(task.key, (t) => {
          t.status = 'queued'
          t.data.interruptions = interruptions
          // Same session, same expected output. A run that never created a session starts over.
          t.data.next = t.sessions[t.stage] ? { purpose: 'resume', schema: run.schemaName } : { ...next, purpose: 'start', schema: run.schemaName }
        })
      } else {
        this.needsYou(task.key, 'executor_failing', `连续 ${interruptions} 次没有正常结束：${outcome.error ?? outcome.kind}`)
      }
      return
    }
    const parsed = validateResult(run.schemaName, outcome.text)
    if (!parsed.ok) {
      this.repairOrStop(task, run.schemaName, parsed.error)
      return
    }
    this.store.updateTask(task.key, (t) => {
      t.data.interruptions = 0
    })
    await this.handleResult(this.store.getTask(task.key)!, run.schemaName, parsed.value)
  }

  private repairOrStop(task: Task, schema: SchemaName, error: string) {
    const repairs = (task.data.repairs ?? 0) + 1
    this.store.event(task.key, 'output_invalid', error)
    if (repairs <= MAX_REPAIRS) {
      this.store.updateTask(task.key, (t) => {
        t.status = 'queued'
        t.data.repairs = repairs
        t.data.next = { purpose: 'repair', schema, message: repairMessage(error) }
      })
    } else {
      this.needsYou(task.key, 'output_invalid', error)
    }
  }

  private async handleResult(task: Task, schema: SchemaName, value: any) {
    const clear = (t: Task) => {
      t.data.repairs = 0
      t.data.next = undefined
    }
    switch (schema) {
      case 'plan':
        if (task.data.revisionChanged) return this.backToPlan(task.key, '需求在你分析期间又更新了。请阅读 .ai-pm/task.json 的最新内容，重新输出完整方案。')
        this.store.updateTask(task.key, (t) => {
          clear(t)
          t.data.plan = value
          t.data.planRevision = t.revision
        })
        return this.needsYou(task.key, 'plan_confirm', value.summary)
      case 'develop':
        return this.handleDevelop(task, value as DevResult)
      case 'alignment':
        this.store.updateTask(task.key, clear)
        task = await this.latest(task)
        if (value.decision === 'resume') {
          return this.write(task, 'task_resume_development', {
            task_id: task.platformId, claim_id: task.claimId, version: task.version, revision: task.revision, body: value.body,
          }, 'development_resumed')
        }
        return this.write(task, 'task_request_alignment', {
          task_id: task.platformId, claim_id: task.claimId, version: task.version, revision: task.revision,
          ...alignmentRequest(value.body, value.questions),
        }, 'alignment_requested')
      case 'release':
        return this.handleRelease(task, value)
      case 'collab': {
        // The platform refuses these empty; asking the agent beats a rejection.
        const empty = ['summary', 'environment', 'observed_at', 'deployment_version', 'limitations', ...(value.outcome === 'confirmed' ? ['evidence'] : [])]
          .filter((field) => !String(value[field] ?? '').trim())
        if (empty.length) return this.repairOrStop(task, 'collab', `这些字段不能为空：${empty.join('、')}`)
        this.store.updateTask(task.key, clear)
        // Lease reports move the version while the investigation runs.
        task = await this.latest(task)
        return this.write(task, 'collaboration_submit_result', {
          collaboration_id: task.platformId, claim_id: task.claimId, version: task.version, ...value,
        }, 'collab_submitted')
      }
    }
  }

  private async handleDevelop(task: Task, result: DevResult) {
    if (task.data.revisionChanged) {
      return this.backToPlan(task.key, '需求在开发期间更新了。请阅读 .ai-pm/task.json 的最新需求，基于已有方案修订，并说明和上一版方案的差别。')
    }
    if (result.status === 'done') {
      const head = await headSha(task.worktree!)
      if (result.sha !== head) return this.repairOrStop(task, 'develop', `sha 不是当前分支的 HEAD（HEAD 是 ${head}）`)
      if (!(await isClean(task.worktree!))) return this.repairOrStop(task, 'develop', '工作区还有未提交的改动，请提交后再输出结果')
      const bug = linkedBug(task)
      if (bug) {
        const sha = await this.integrateFix(task, bug.branch)
        if (!sha) return
        result = { ...result, sha }
      }
      this.store.updateTask(task.key, (t) => {
        t.data.repairs = 0
        t.data.next = undefined
        t.data.dev = result
      })
      this.write(task, 'task_report_work', { task_id: task.platformId, claim_id: task.claimId, report_kind: 'progress', body: '开发完成：' + result.summary }, 'none')
      return this.needsYou(task.key, 'ready_to_test', result.summary)
    }
    this.store.updateTask(task.key, (t) => {
      t.data.repairs = 0
      t.data.next = undefined
    })
    if (result.status === 'needs_alignment') {
      task = await this.latest(task)
      return this.write(task, 'task_request_alignment', {
        task_id: task.platformId, claim_id: task.claimId, version: task.version, revision: task.revision,
        ...alignmentRequest(result.message || '开发中有需要产品确认的问题。', result.alignment_questions),
      }, 'alignment_requested')
    }
    return this.needsYou(task.key, 'agent_question', result.message || result.summary)
  }

  // The platform retests a requirement only on a version that contains every
  // verified fix, so a linked bug's commits go onto the requirement's branch.
  private async integrateFix(task: Task, target: string): Promise<string | null> {
    if (!target) {
      this.needsYou(task.key, 'merge_failed', '平台没有登记所属需求的开发分支，修复无法合入。')
      return null
    }
    let outcome: Integration
    try {
      outcome = await this.onBranch(target, () => integrateInto({ repoPath: this.d.settings().repoPath, worktree: task.worktree!, target }))
    } catch (error) {
      this.needsYou(task.key, 'merge_failed', `合入 ${target} 失败：${errorText(error)}`)
      return null
    }
    if ('conflict' in outcome) {
      const attempts = (task.data.mergeAttempts ?? 0) + 1
      this.store.event(task.key, 'merge_conflict', target)
      if (attempts > MAX_REPAIRS) {
        this.needsYou(task.key, 'merge_failed', `修复和 ${target} 上的新提交冲突，让 Agent 合并了 ${MAX_REPAIRS} 次都没有成功。`)
        return null
      }
      this.store.updateTask(task.key, (t) => {
        t.status = 'queued'
        t.data.mergeAttempts = attempts
        t.data.next = {
          purpose: 'continue',
          message: `所属需求分支 ${target} 在你修复期间有了新的提交，和你的修改冲突。请在当前分支执行 git merge ${target}，解决冲突并提交，确认测试仍然通过，然后输出结果 JSON。`,
        }
      })
      return null
    }
    this.store.updateTask(task.key, (t) => {
      t.data.mergeAttempts = 0
      t.data.integratedInto = target
    })
    return outcome.sha
  }

  // Runs git work on one branch at a time, so two fixes never race to move it.
  private branchQueue = new Map<string, Promise<unknown>>()
  private onBranch<T>(branch: string, work: () => Promise<T>): Promise<T> {
    const next = (this.branchQueue.get(branch) ?? Promise.resolve()).then(work, work)
    this.branchQueue.set(branch, next.catch(() => {}))
    return next
  }

  private handleRelease(batch: Task, value: any) {
    const members = (batch.data.members ?? []).map((key) => this.store.getTask(key)).filter((t): t is Task => !!t)
    if (value.outcome !== 'success') {
      this.store.updateTask(batch.key, (t) => {
        t.data.repairs = 0
        t.data.next = undefined
        t.data.release = value
      })
      return this.needsYou(batch.key, 'release_failed', [value.summary, value.limitations].filter(Boolean).join('\n'))
    }
    this.completeBatch(batch, value, members)
  }

  completeBatch(batch: Task, value: any, members: Task[]) {
    this.store.tx(() => {
      for (const member of members) {
        const dev = member.data.dev
        if (batch.stage === 'test_release') {
          this.write(member, 'task_submit_result', {
            task_id: member.platformId, claim_id: member.claimId, revision: member.revision,
            summary: dev?.summary ?? '', sha: dev?.sha ?? '', tests: dev?.tests ?? '',
            limitations: dev?.limitations ?? '', environment: value.environment,
          }, 'submitted')
        } else {
          this.write(member, 'task_mark_deployed', {
            task_id: member.platformId, claim_id: member.claimId, revision: member.revision,
            sha: member.data.submittedSha ?? dev?.sha ?? '', environment: value.environment,
            body: [value.summary, value.verification, '实际部署版本：' + value.deployed_sha].filter(Boolean).join('\n'),
          }, 'deployed')
        }
      }
      this.store.updateTask(batch.key, (t) => {
        t.status = 'done'
        t.reason = null
        t.detail = value.summary
        t.data.next = undefined
        t.data.release = value
      })
      this.store.event(batch.key, 'batch_done', value.summary)
    })
  }

  // Version-checked writes need the newest version; a failed read keeps what we have
  // and a stale version comes back as platform_rejected with a retry button.
  private async latest(task: Task): Promise<Task> {
    try {
      await this.refreshTask(task)
    } catch (error) {
      this.store.event(task.key, 'error', errorText(error))
    }
    return this.store.getTask(task.key)!
  }

  private backToPlan(key: string, message: string) {
    this.store.updateTask(key, (t) => {
      t.stage = 'plan'
      t.status = 'queued'
      t.reason = null
      t.data.revisionChanged = false
      t.data.planApproval = null
      t.data.plan = null
      t.data.next = { purpose: 'continue', message }
    })
    this.store.event(key, 'back_to_plan', message)
  }

  // ---------------- state helpers ----------------

  needsYou(key: string, reason: NeedsReason, detail: string) {
    const task = this.store.updateTask(key, (t) => {
      t.status = 'needs_you'
      t.reason = reason
      t.detail = detail
    })
    this.store.event(key, 'needs_you', `${reason}: ${detail}`)
    this.d.onNeedsYou?.(task)
  }

  private wait(task: Task, reason: WaitReason) {
    task.status = 'waiting'
    task.reason = reason
  }

  // Queues a platform write. The task waits in "syncing" unless the write is a
  // best-effort report (effect "none").
  write(task: Task, tool: string, params: Record<string, unknown>, effect: string, effectArgs: Record<string, unknown> = {}) {
    this.store.tx(() => {
      this.store.enqueue({ taskKey: task.key, tool, params, effect, effectArgs })
      if (effect !== 'none') {
        this.store.updateTask(task.key, (t) => this.wait(t, 'syncing'))
      }
    })
  }

  private retryLater(key: string, error: unknown) {
    const message = errorText(error)
    this.store.updateTask(key, (t) => {
      t.failures += 1
      t.lastError = message
      t.retryAt = this.clock() + backoff(this.d.timing(), t.failures - 1)
    })
    this.store.event(key, 'retry', message)
  }

  private noteError(key: string, error: unknown) {
    const message = errorText(error)
    if (!this.store.getTask(key)) return
    this.store.updateTask(key, (t) => {
      t.failures += 1
      t.lastError = message
    })
    this.store.event(key, 'error', message)
  }

  private renewCollaborationLeases() {
    const every = this.d.timing().collabReportMs
    for (const task of this.store.listTasks({ status: ['running'], kind: ['collaboration'] })) {
      if (this.clock() - (task.data.lastReportAt ?? 0) < every) continue
      this.store.tx(() => {
        this.store.updateTask(task.key, (t) => {
          t.data.lastReportAt = this.clock()
        })
        this.write(task, 'collaboration_report', {
          collaboration_id: task.platformId, claim_id: task.claimId, report_kind: 'progress',
          body: '本地执行会话仍在运行，尚未得出结论。',
        }, 'none')
      })
    }
  }

  async killRun(key: string) {
    for (const run of this.store.openRuns().filter((r) => r.taskKey === key)) {
      await this.executor(run.executor).kill(run)
      this.store.endRun(run.id, 'interrupted', null, 'stopped by client')
    }
  }

  // ---------------- outbox effects ----------------

  readonly outboxHandlers: OutboxHandlers = {
    onDone: (item, result) => this.applyEffect(item, result),
    onRejected: (item, error) => this.applyRejection(item, error),
    onHandlerError: (item, error) => this.noteError(item.taskKey, error),
  }

  private applyEffect(item: OutboxRow, result: any) {
    const task = this.store.getTask(item.taskKey)
    if (!task) return
    const remote = result?.task ?? result?.collaboration
    this.store.updateTask(task.key, (t) => {
      // A replay answers with the state as of the first attempt; versions only grow,
      // so only a newer answer moves what we show as the platform's state.
      if (typeof remote?.version === 'number' && remote.version > (t.version ?? 0)) {
        t.version = remote.version
        t.platformStatus = remote.status ?? t.platformStatus
      }
      switch (item.effect) {
        case 'claimed':
        case 'collab_claimed':
          t.claimId = result.claim_id
          t.data.claiming = false
          t.status = 'queued'
          t.reason = null
          t.data.next = { purpose: 'start' }
          break
        case 'alignment_requested':
          this.wait(t, 'aligning')
          break
        case 'development_resumed':
          t.claimId = result.claim_id ?? t.claimId
          t.stage = 'develop'
          t.status = 'queued'
          t.reason = null
          t.data.next = { purpose: 'continue', message: '对齐已完成，平台已恢复开发。请按产品回复继续实现。' }
          break
        case 'submitted':
          t.data.submittedSha = String(item.params.sha ?? '')
          t.data.batch = null
          this.wait(t, 'testing')
          break
        case 'deployed':
          t.data.batch = null
          this.wait(t, 'acceptance')
          break
        case 'reworked':
          t.stage = 'develop'
          t.status = 'queued'
          t.reason = null
          t.data.next = { purpose: 'continue', message: String(item.effectArgs.message ?? '请继续修改。') }
          break
        case 'released':
        case 'closed':
          t.status = 'closed'
          t.reason = null
          t.data.released = item.effect === 'released'
          break
        case 'collab_submitted':
          t.status = 'done'
          t.reason = null
          break
      }
    })
    this.store.event(task.key, 'platform_ok', item.tool)
  }

  private applyRejection(item: OutboxRow, error: PlatformError) {
    const task = this.store.getTask(item.taskKey)
    if (!task || item.effect === 'none') return
    if (item.effect === 'claimed' || item.effect === 'collab_claimed') {
      // Someone else got it first. Nothing local to keep.
      this.store.updateTask(task.key, (t) => {
        t.status = 'closed'
        t.reason = null
        t.detail = '认领失败：' + error.message
        t.data.claiming = false
      })
      return
    }
    this.store.updateTask(task.key, (t) => {
      t.data.rejected = { outboxId: item.id, tool: item.tool, error: error.message }
    })
    this.needsYou(task.key, 'platform_rejected', `${item.tool}：${error.message}`)
  }

  // ---------------- reconcile: platform state ----------------

  private async validateBinding() {
    if (this.clock() - this.bindingCheckedAt < this.d.timing().bindingCheckMs) return
    const settings = this.d.settings()
    const context = await this.d.platform.call('project_get_context', {})
    const project = context.project ?? {}
    if (project.id !== settings.projectId) throw new BindingError('平台项目与配置不一致：' + project.id)
    const origin = await originUrl(settings.repoPath)
    const expected = repositoryIdentity(settings.repository)
    if (repositoryIdentity(project.repository ?? '') !== expected || repositoryIdentity(origin) !== expected) {
      throw new BindingError('本地仓库或平台仓库与配置不一致')
    }
    this.bindingCheckedAt = this.clock()
  }

  async reconcile(): Promise<void> {
    const settings = this.d.settings()
    await this.validateBinding()
    const work = await this.d.platform.call('work_list', {})
    await this.reopenReturnedBugs(work)
    for (const task of this.store.listTasks({ status: [...OPEN], kind: ['task', 'collaboration'] })) {
      if (task.data.claiming) continue
      try {
        await this.refreshTask(task, true)
      } catch (error) {
        this.noteError(task.key, error)
      }
    }
    if (!settings.intakePaused && !this.d.outbox.authBlocked && !(await this.checkContract())) this.intake(work)
  }

  // A resolved bug is done here and leaves the work list. If the product later
  // finds the fix did not hold, it comes back as ours in "doing".
  private async reopenReturnedBugs(work: any) {
    for (const item of work.tasks ?? []) {
      const task = item.status === 'doing' ? this.store.getTask('task:' + item.id) : null
      if (task?.status !== 'done' || !task.data.resolvedBug) continue
      try {
        await this.refreshTask(task)
      } catch (error) {
        this.noteError(task.key, error)
        continue
      }
      this.store.updateTask(task.key, (t) => {
        t.stage = 'develop'
        t.status = 'queued'
        t.reason = null
        t.detail = null
        t.data.resolvedBug = false
        t.data.feedback = [...(t.data.feedback ?? []), { at: now(), source: '产品退回', text: '已验证解决的 Bug 被产品退回修复，原因见 .ai-pm/task.json 中的最新事件。' }]
        t.data.next = { purpose: 'continue', message: '这个 Bug 验证通过后又被产品退回修复。请阅读 .ai-pm/task.json 和 .ai-pm/feedback.md 的最新内容，修复后重新输出结果。' }
      })
      this.store.event(task.key, 'bug_returned', '产品退回了已解决的 Bug')
    }
  }

  // Before taking new work, make sure the platform reports errors with codes.
  // A pass is trusted for a while; a failure is checked again every time.
  async checkContract(force = false): Promise<string | null> {
    if (!force && !this.contractError && this.contractCheckedAt && this.clock() - this.contractCheckedAt < CONTRACT_RECHECK_MS) return null
    this.contractError = await contractProblem(this.d.platform)
    this.contractCheckedAt = this.clock()
    if (this.contractError) this.store.event(null, 'contract_failed', this.contractError)
    return this.contractError
  }

  private claimable(kind: 'task' | 'collaboration', item: any): boolean {
    if (item.project_id && item.project_id !== this.d.settings().projectId) return false
    if (kind === 'task') return item.status === 'ready' && !(item.alignment && item.alignment.status !== 'completed')
    return item.status === 'pending' || (['investigating', 'blocked'].includes(item.status) && typeof item.lease_until === 'number' && item.lease_until <= this.clock())
  }

  private activeFor(executor: ExecutorName): number {
    return this.store.listTasks({ status: ['queued', 'running', 'waiting'] })
      .filter((t) => t.executor === executor && (t.status !== 'waiting' || t.data.claiming)).length
  }

  private pickExecutor(): ExecutorName | null {
    const settings = this.d.settings()
    for (const name of settings.allowedExecutors) {
      const config = settings.executors[name]
      if (!config || !this.d.executors[name] || this.health[name] === false) continue
      if (this.activeFor(name) < config.limit) return name
    }
    return null
  }

  private intake(work: any) {
    const settings = this.d.settings()
    const items: ['task' | 'collaboration', any][] = [
      ...(work.collaborations ?? []).map((c: any) => ['collaboration', c] as ['collaboration', any]),
      ...(work.tasks ?? []).map((t: any) => ['task', t] as ['task', any]),
    ]
    for (const [kind, item] of items) {
      if (!this.claimable(kind, item)) continue
      const key = kind + ':' + item.id
      const existing = this.store.getTask(key)
      if (existing && (OPEN as readonly string[]).includes(existing.status)) continue
      // Handed back for someone else; claiming it again would undo that.
      if (existing?.data.released) continue
      if (this.store.listTasks({ status: [...OPEN], kind: ['task', 'collaboration'] }).length >= settings.maxOpenTasks) return
      const executor = this.pickExecutor()
      if (!executor) return
      const stamp = now()
      const task: Task = {
        key, kind, platformId: item.id, title: item.title ?? item.id, stage: kind === 'task' ? 'plan' : 'collab',
        status: 'waiting', reason: 'syncing', detail: null, executor,
        models: structuredClone(settings.executors[executor]?.models ?? {}),
        claimId: null, revision: item.revision ?? null, version: item.version ?? null, platformStatus: item.status,
        branch: kind === 'task' ? 'ai-pm/' + item.id : null, worktree: existing?.worktree ?? null,
        sessions: {}, data: { claiming: true }, retryAt: null, failures: 0, lastError: null, createdAt: stamp, updatedAt: stamp,
      }
      this.store.tx(() => {
        this.store.saveTask(task)
        this.store.enqueue({
          taskKey: key,
          tool: kind === 'task' ? 'task_claim' : 'collaboration_claim',
          params: kind === 'task' ? { task_id: item.id, branch: task.branch } : { collaboration_id: item.id },
          effect: kind === 'task' ? 'claimed' : 'collab_claimed',
        })
        this.store.event(key, 'claiming', task.title)
      })
    }
  }

  // Reads one task's platform state and applies the transitions it implies.
  async refreshTask(task: Task, applyTransitions = false) {
    const raw = task.kind === 'task'
      ? await this.d.platform.call('task_get_context', { task_id: task.platformId })
      : await this.d.platform.call('collaboration_get', { collaboration_id: task.platformId })
    const remote = task.kind === 'task' ? (raw.task ?? raw) : raw
    let kill = false
    this.store.updateTask(task.key, (t) => {
      const revisionChanged = t.revision != null && remote.revision != null && remote.revision !== t.revision
      t.platformStatus = remote.status ?? t.platformStatus
      t.version = remote.version ?? t.version
      t.revision = remote.revision ?? t.revision
      t.title = remote.title ?? t.title
      t.data.context = trimContext(raw)
      if (!applyTransitions) return
      if (PLATFORM_CLOSED.has(remote.status)) {
        kill = t.status === 'running'
        t.status = 'closed'
        t.reason = null
        t.detail = '平台上已' + (({ rejected: '拒绝', closed: '关闭' } as Record<string, string>)[remote.status] ?? '取消')
        return
      }
      if (t.kind === 'collaboration') {
        if (remote.status === 'completed') t.status = 'done'
        return
      }
      const waitingFor = t.status === 'waiting' ? t.reason : null
      if (waitingFor === 'aligning' && remote.alignment?.status === 'replied') {
        t.stage = 'develop'
        t.status = 'queued'
        t.reason = null
        t.data.feedback = [...(t.data.feedback ?? []), { at: now(), source: '产品回复', text: String(remote.alignment.reply ?? '见 task.json') }]
        t.data.next = { purpose: 'alignment', schema: 'alignment' }
      } else if (waitingFor === 'testing' && remote.status === 'pending_release') {
        t.status = 'needs_you'
        t.reason = 'ready_to_release'
        t.detail = t.data.dev?.summary ?? null
        t.stage = 'release'
        // After a retest the product tested a newer version that has the bug fixes.
        t.data.submittedSha = remote.submission?.sha ?? t.data.submittedSha
      } else if (waitingFor === 'testing' && remote.status === 'resolved') {
        t.status = 'done'
        t.reason = null
        t.detail = '产品已验证解决。修复随所属需求一起复测和上线。'
        t.data.resolvedBug = true
      } else if (waitingFor === 'testing' && (remote.status === 'fixing' || remote.status === 'retest')) {
        // Bugs filed against this requirement are fixed as their own tasks; this one waits.
        t.detail = remote.status === 'fixing' ? '产品提了 Bug，等这些 Bug 修复并验证。' : 'Bug 都已解决，等产品开始复测。'
      } else if ((waitingFor === 'testing' || waitingFor === 'acceptance') && remote.status === 'doing') {
        t.stage = 'develop'
        t.status = 'queued'
        t.reason = null
        const what = linkedBug(t) ? '这个 Bug 的修复没有通过产品验证，被退回修复' : '需求被退回开发'
        t.data.feedback = [...(t.data.feedback ?? []), { at: now(), source: '平台退回', text: `${what}，请查看 .ai-pm/task.json 中的最新事件。` }]
        t.data.next = { purpose: 'continue', message: `${what}。请阅读 .ai-pm/task.json 和 .ai-pm/feedback.md 的最新内容，修改后重新提交。` }
      } else if (waitingFor === 'testing' && remote.status === 'review') {
        this.wait(t, 'acceptance')
      } else if (['done', 'completed'].includes(remote.status)) {
        t.status = 'done'
        t.reason = null
      } else if (revisionChanged && (t.stage === 'plan' || t.stage === 'develop')) {
        if (t.status === 'running') t.data.revisionChanged = true
        else if (t.status === 'queued' || t.status === 'needs_you') {
          t.stage = 'plan'
          t.status = 'queued'
          t.reason = null
          t.data.planApproval = null
          t.data.plan = null
          t.data.next = { purpose: t.sessions.plan ? 'continue' : 'start', message: '需求已更新。请阅读 .ai-pm/task.json 的最新内容，重新输出完整方案。' }
        }
      }
    })
    if (kill) await this.killRun(task.key)
    const after = this.store.getTask(task.key)!
    if (after.status === 'needs_you' && after.reason === 'ready_to_release' && task.reason !== 'ready_to_release') this.d.onNeedsYou?.(after)
  }
}
