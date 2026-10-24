// Opt-in smoke test with the real Codex CLI. It uses a throwaway repository and
// the local fake platform, never the production task pool, and calls the model
// a handful of times.
//   npx tsx scripts/smoke-real-codex.ts [--codex <path>] [--model <id>] [--effort low] [--skip-crash]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorld, until, type World } from '../test/helpers.js'

// Any needs_you reason counts as the end of a step; the check then says whether it was the right one.
const untilNeedsYou = (world: World, timeoutMs: number) =>
  until(() => world.engine.store.getTask(KEY)!, (t) => t?.status === 'needs_you', KEY + ' → needs_you', timeoutMs)

const argv = process.argv.slice(2)
const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const codex = option('--codex') ?? '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
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

function runReport(world: World) {
  return world.engine.store.runsFor(KEY).map((run) => {
    const events = existsSync(run.logPath)
      ? readFileSync(run.logPath, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
      : []
    const types = [...new Set(events.map((e) => e.type))]
    const items = [...new Set(events.filter((e) => e.item).map((e) => e.item.type))]
    const thread = events.find((e) => e.type === 'thread.started')?.thread_id
    return { run, types, items, thread, seconds: run.endedAt ? (Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000 : null }
  })
}

async function main() {
  log(`codex: ${execFileSync(codex, ['--version'], { encoding: 'utf8' }).trim()}; model: ${model ?? '(CLI default)'}; effort: ${effort}`)
  const world = await makeWorld({
    files: {
      'package.json': JSON.stringify({ name: 'smoke', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
      'src/math.js': 'export function add(a, b) {\n  return a + b\n}\n',
      'test/math.test.js': "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../src/math.js'\n\ntest('add', () => assert.equal(add(1, 2), 3))\n",
    },
    settings: {
      executors: { codex: { binary: codex, limit: 1, models: { expert: { model, effort }, execution: { model, effort } } } },
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

    log('3/4 continue: asking for a change in the same development session')
    await world.engine.command('requestChanges', KEY, '再新增并导出 divide(a, b)：b 为 0 时抛出 Error("division by zero")，并补测试。')
    const changed = await untilNeedsYou(world, 20 * MINUTES)
    check('continued run reaches ready_to_test', changed.reason === 'ready_to_test', `${changed.reason}: ${changed.detail ?? ''}`.slice(0, 200))

    if (!argv.includes('--skip-crash')) {
      log('4/4 crash: killing the agent mid-run, then expecting a resume in the same session')
      await world.engine.command('requestChanges', KEY, '再新增并导出 subtract(a, b)，并补测试。')
      const victim = await until(() => world.engine.store.openRuns().find((r) => r.taskKey === KEY && r.sessionId), Boolean, 'running with a session', 5 * MINUTES)
      await new Promise((resolve) => setTimeout(resolve, 15_000))
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
      log(`run ${r.run.stage}/${r.run.purpose} schema=${r.run.schemaName} outcome=${r.run.outcome} ${r.seconds ?? '?'}s session=${r.run.sessionId?.slice(0, 8)} events=[${r.types.join(',')}] items=[${r.items.join(',')}]`)
    }
    const develops = reports.filter((r) => r.run.stage === 'develop')
    check('every run emitted thread.started with the session id', reports.every((r) => !r.run.sessionId || r.thread === r.run.sessionId))
    check('completed runs ended with turn.completed', reports.filter((r) => r.run.outcome === 'completed').every((r) => r.types.includes('turn.completed')))
    check('development turns share one session', new Set(develops.map((r) => r.run.sessionId)).size === 1, `${develops.length} runs`)
    check('plan output passed the schema without repairs', !reports.some((r) => r.run.stage === 'plan' && r.run.purpose === 'repair'))
    check('no repair runs were needed', !reports.some((r) => r.run.purpose === 'repair'), reports.filter((r) => r.run.purpose === 'repair').length + ' repairs')
    if (!argv.includes('--skip-crash')) check('a resume run followed the crash', develops.some((r) => r.run.purpose === 'resume'))
    check('agents made no MCP tool calls', reports.every((r) => !r.items.includes('mcp_tool_call')))
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
