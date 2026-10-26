// Opt-in smoke test with a real agent CLI (Codex, Claude Code or ZCode). It uses a
// throwaway repository and the local fake platform, never the production task
// pool, and calls the model a handful of times.
//   npx tsx scripts/smoke-real-executor.ts [--executor codex|claude|zcode] [--binary <path>] [--runtime <path>]
//     [--model <id>] [--effort <level>] [--skip-crash] [--kill-after <seconds>] [--review <executor>]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { findExecutor } from '../src/main/controller.js'
import { zcodeCommand } from '../src/core/executors/zcode.js'
import type { ExecutorName, ExecutorSettings } from '../src/core/types.js'
import { makeWorld, until, type World } from '../test/helpers.js'

// Any needs_you reason counts as the end of a step; the check then says whether it was the right one.
const untilNeedsYou = (world: World, timeoutMs: number) =>
  until(() => world.engine.store.getTask(KEY)!, (t) => t?.status === 'needs_you', KEY + ' → needs_you', timeoutMs)

const argv = process.argv.slice(2)
const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const executor = (option('--executor') ?? 'codex') as ExecutorName
const model = option('--model')
const effort = option('--effort') ?? 'low'
const MINUTES = 60_000
const KEY = 'task:tsk_smoke'
const started = Date.now()
const log = (message: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${message}`)
const checks: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

// What each executor's log says about a run: its session id, whether it ended
// with a result, and the MCP tools it called.
function runReport(world: World) {
  return world.engine.store.runsFor(KEY).map((run) => {
    const events = existsSync(run.logPath)
      ? readFileSync(run.logPath, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
      : []
    let session: string | undefined
    let finished = false
    let mcp: string[] = []
    if (run.executor === 'codex') {
      session = events.find((e) => e.type === 'thread.started')?.thread_id
      finished = events.some((e) => e.type === 'turn.completed')
      mcp = events.filter((e) => e.item?.type === 'mcp_tool_call').map((e) => e.item.tool)
    } else if (run.executor === 'claude') {
      session = events.find((e) => e.session_id)?.session_id
      finished = events.some((e) => e.type === 'result' && e.subtype === 'success')
      mcp = events.flatMap((e) => (e.type === 'assistant' ? e.message.content : [])).filter((c: any) => c.type === 'tool_use' && c.name.startsWith('mcp__')).map((c: any) => c.name)
    } else {
      session = events.find((e) => e.type === 'zcode.session')?.sessionId
      finished = events.some((e) => e.type === 'zcode.result' && e.status === 'completed')
      mcp = events.filter((e) => e.event?.payload?.kind === 'tool_call' && /mcp/i.test(e.event.payload.toolName)).map((e) => e.event.payload.toolName)
    }
    return { run, session, finished, mcp, lines: events.length, seconds: run.endedAt ? (Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000 : null }
  })
}

async function main() {
  // The binary the app itself would find, unless one is given.
  const found = findExecutor(executor)
  const config: ExecutorSettings = {
    binary: option('--binary') ?? found?.binary ?? '', runtime: option('--runtime') ?? found?.runtime, limit: 1,
    models: { expert: { model, effort }, execution: { model, effort } },
  }
  if (!config.binary) throw new Error('no ' + executor + ' binary found; pass --binary')
  const { command, env } = executor === 'zcode' ? zcodeCommand(config) : { command: [config.binary], env: {} }
  const version = execFileSync(command[0], [...command.slice(1), '--version'], { encoding: 'utf8', env: { ...process.env, ...env } }).trim()
  log(`${executor}: ${version}; model: ${model ?? '(CLI default)'}; effort: ${effort}`)
  // An AI review after development, on this executor with its default model.
  const reviewer = option('--review') as ExecutorName | undefined
  const reviewerFound = reviewer && reviewer !== executor ? findExecutor(reviewer) : null
  if (reviewer && reviewer !== executor && !reviewerFound) throw new Error('no ' + reviewer + ' binary found')
  const world = await makeWorld({
    files: {
      'package.json': JSON.stringify({ name: 'smoke', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
      'src/math.js': 'export function add(a, b) {\n  return a + b\n}\n',
      'test/math.test.js': "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../src/math.js'\n\ntest('add', () => assert.equal(add(1, 2), 3))\n",
    },
    settings: {
      executors: { [executor]: config, ...(reviewerFound ? { [reviewer!]: { ...reviewerFound, limit: 1 } } : {}) },
      allowedExecutors: [executor],
      timing: {
        tickMs: 500, pollActiveMs: 10_000, pollIdleMs: 10_000, backoffMs: [2_000, 5_000, 10_000], reconnectMs: [500, 1_000],
        collabReportMs: 180_000, callTimeoutMs: 10_000, bindingCheckMs: 0, probeMs: 600_000,
      },
    },
  })
  log('workspace: ' + world.root)
  let failed = false
  try {
    world.fake.addTask('tsk_smoke', '新增 multiply 函数')
    world.fake.update('tsk_smoke', (t) => {
      t.brief = '在 src/math.js 新增并导出 multiply(a, b)，返回两数之积。'
      t.acceptance_criteria = 'multiply(2, 3) 返回 6；test/math.test.js 增加对应测试；npm test 通过。'
    })

    log('1/4 plan: waiting for the read-only plan run')
    const planned = await untilNeedsYou(world, 15 * MINUTES)
    check('plan reaches plan_confirm', planned.reason === 'plan_confirm', `${planned.reason}: ${planned.detail ?? ''}`.slice(0, 200))
    if (planned.reason !== 'plan_confirm') throw new Error('plan did not complete')

    log('2/4 develop: confirming the plan')
    await world.engine.command('confirmPlan', KEY, {})
    const developed = await untilNeedsYou(world, 20 * MINUTES)
    check('develop reaches ready_to_test', developed.reason === 'ready_to_test', `${developed.reason}: ${developed.detail ?? ''}`.slice(0, 200))
    if (developed.reason !== 'ready_to_test') throw new Error('develop did not complete')
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: developed.worktree!, encoding: 'utf8' }).trim()
    check('reported sha is the branch HEAD', developed.data.dev?.sha === head, head.slice(0, 12))

    if (reviewer) {
      log(`review: ${reviewer} reviews the development, read-only`)
      await world.engine.command('startReview', KEY, reviewer)
      const reviewed = await untilNeedsYou(world, 20 * MINUTES)
      check('review reaches review_ready', reviewed.reason === 'review_ready', `${reviewed.reason}: ${reviewed.detail ?? ''}`.slice(0, 200))
      const round = reviewed.data.reviews?.at(-1)
      check('review covers the developed commit', round?.sha === head, round?.sha?.slice(0, 12))
      check('review left the worktree untouched', execFileSync('git', ['status', '--porcelain'], { cwd: reviewed.worktree!, encoding: 'utf8' }) === '' &&
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: reviewed.worktree!, encoding: 'utf8' }).trim() === head)
      log(`review: ${round?.verdict}, ${round?.items.length} items: ${round?.items.map((i) => `${i.id}/${i.severity} ${i.title}`).join('; ')}`)
      const fixes = (round?.items ?? []).filter((i) => i.severity !== 'optional').map((i) => i.id)
      if (fixes.length) {
        await world.engine.command('applyReview', KEY, fixes, '')
        const fixed = await untilNeedsYou(world, 20 * MINUTES)
        check('fixes from the review reach ready_to_test', fixed.reason === 'ready_to_test', `${fixed.reason}: ${fixed.detail ?? ''}`.slice(0, 200))
      } else {
        // Nothing to fix: back to ready_to_test the way a person would, by leaving the review.
        world.engine.store.updateTask(KEY, (t) => {
          t.stage = 'develop'
          t.status = 'needs_you'
          t.reason = 'ready_to_test'
        })
      }
    }

    log('3/4 continue: asking for a change in the same development session')
    await world.engine.command('requestChanges', KEY, '再新增并导出 divide(a, b)：b 为 0 时抛出 Error("division by zero")，并补测试。')
    const changed = await untilNeedsYou(world, 20 * MINUTES)
    check('continued run reaches ready_to_test', changed.reason === 'ready_to_test', `${changed.reason}: ${changed.detail ?? ''}`.slice(0, 200))

    if (!argv.includes('--skip-crash')) {
      log('4/4 crash: killing the agent mid-run, then expecting a resume in the same session')
      await world.engine.command('requestChanges', KEY, '再新增并导出 subtract(a, b)，并补测试。')
      const victim = await until(() => world.engine.store.openRuns().find((r) => r.taskKey === KEY && r.sessionId), Boolean, 'running with a session', 5 * MINUTES)
      // Quick agents finish a small change in seconds; kill before that.
      await new Promise((resolve) => setTimeout(resolve, Number(option('--kill-after') ?? 15) * 1_000))
      if (world.engine.store.openRuns().some((r) => r.id === victim!.id)) {
        try {
          process.kill(-victim!.pid, 'SIGKILL')
        } catch {
          process.kill(victim!.pid, 'SIGKILL')
        }
        log(`killed pid ${victim!.pid}`)
      } else {
        log('run finished before it could be killed; resume path not exercised')
      }
      const resumed = await untilNeedsYou(world, 20 * MINUTES)
      check('run after a crash reaches ready_to_test', resumed.reason === 'ready_to_test', `${resumed.reason}: ${resumed.detail ?? ''}`.slice(0, 200))
    }

    const reports = runReport(world)
    for (const r of reports) {
      log(`run ${r.run.stage}/${r.run.purpose} schema=${r.run.schemaName} outcome=${r.run.outcome} ${r.seconds ?? '?'}s session=${r.run.sessionId?.slice(0, 12)} lines=${r.lines}`)
    }
    const develops = reports.filter((r) => r.run.stage === 'develop')
    if (reviewer) check('review runs were read-only on the reviewer', reports.filter((r) => r.run.stage === 'review').every((r) => r.run.executor === reviewer))
    check('every run logged its session id', reports.every((r) => !r.run.sessionId || r.session === r.run.sessionId))
    check('completed runs ended with a result', reports.filter((r) => r.run.outcome === 'completed').every((r) => r.finished))
    check('development turns share one session', new Set(develops.map((r) => r.run.sessionId)).size === 1, `${develops.length} runs`)
    check('plan output passed the schema without repairs', !reports.some((r) => r.run.stage === 'plan' && r.run.purpose === 'repair'))
    check('no repair runs were needed', !reports.some((r) => r.run.purpose === 'repair'), reports.filter((r) => r.run.purpose === 'repair').length + ' repairs')
    if (!argv.includes('--skip-crash')) check('a resume run followed the crash', develops.some((r) => r.run.purpose === 'resume'))
    check('agents made no MCP tool calls', reports.every((r) => !r.mcp.length), reports.flatMap((r) => r.mcp).join(', '))
    const worktree = world.task(KEY).worktree!
    check('worktree is clean and .ai-pm is not committed',
      execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' }) === '' &&
      !execFileSync('git', ['log', '--name-only', '--format='], { cwd: worktree, encoding: 'utf8' }).includes('.ai-pm'))
    let testsPass = true
    try {
      execFileSync('npm', ['test', '--silent'], { cwd: worktree, stdio: 'ignore', timeout: 60_000 })
    } catch {
      testsPass = false
    }
    check('npm test passes on the agent branch', testsPass)
    check('fake platform received no writes besides claim and progress reports',
      world.fake.calls.every((c) => ['task_claim', 'task_report_work', 'task_get_context', 'work_list', 'project_get_context'].includes(c.tool)))
  } catch (error) {
    failed = true
    log('ERROR ' + (error instanceof Error ? error.message : String(error)))
    for (const r of runReport(world)) {
      log(`run ${r.run.stage}/${r.run.purpose} outcome=${r.run.outcome} error=${r.run.error?.slice(0, 300) ?? ''} log=${r.run.logPath}`)
    }
    for (const e of world.engine.store.events(KEY, 30).reverse()) log(`event ${e.type}: ${e.message.slice(0, 300)}`)
  } finally {
    const bad = checks.filter((c) => !c.ok)
    failed ||= bad.length > 0
    log(`${checks.length - bad.length}/${checks.length} checks passed`)
    if (failed) {
      log('keeping workspace for inspection: ' + world.root)
      await world.engine.stop().catch(() => {})
      await world.fake.stop()
    } else {
      await world.dispose()
    }
    process.exit(failed ? 1 : 0)
  }
}

void main()
