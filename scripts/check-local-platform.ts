// Runs the v2 client against the real AI PM platform, built from source and run
// on this machine only: a temporary SQLite database, a throwaway Git repository,
// a deterministic review worker instead of a model, and the fake Codex. The
// script plays the product user through the platform's own HTTP API, so it
// checks the protocol, not the agents. It never touches the production pool.
//   npx tsx scripts/check-local-platform.ts [--platform <ai-pm-system checkout>] [--keep]
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Engine } from '../src/core/engine.js'
import { login, OAuthTokenProvider } from '../src/core/platform/oauth.js'
import { McpPlatform } from '../src/core/platform/client.js'
import { Store } from '../src/core/store.js'
import type { Settings, Task } from '../src/core/types.js'

const argv = process.argv.slice(2)
const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const platformDir = resolve(option('--platform') ?? join(homedir(), 'Documents/ChatGPT/ai-pm-system'))
const keep = argv.includes('--keep')
const FAKE_CODEX = resolve(import.meta.dirname, '../test/fake-codex.mjs')

const started = Date.now()
const log = (message: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${message}`)
const checks: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1')
  await new Promise((done) => server.once('listening', done))
  const port = (server.address() as { port: number }).port
  await new Promise((done) => server.close(done))
  return port
}

async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    try {
      last = await read()
      if (accept(last)) return last
    } catch {
      // Not there yet.
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`timed out waiting for ${label}; last value: ${JSON.stringify(last)?.slice(0, 1500)}`)
}

// Answers every model run without a model. Bug reviews confirm the bug,
// requirement reviews ask a question (the script readies requirements itself),
// and questions and collaboration follow-ups get a one-line answer.
const WORKER = `
import readline from 'node:readline'
const emit = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const finish = (text) => { emit({ type: 'done', text }); setTimeout(() => process.exit(0), 20) }
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.type === 'stop') return finish('')
  if (m.type === 'tool_result') return finish('已保存')
  if (m.type !== 'start') return
  const source = m.review_context
  if (source?.requirement?.parent_requirement_id) {
    return emit({ type: 'tool_call', id: 'review', name: 'submit_requirement_review', args: {
      reply: '问题存在，范围明确。', decision: 'ready', agenda: [],
      proposal: { description: source.requirement.description, acceptance: ['问题不再出现'] } } })
  }
  if (source) {
    return emit({ type: 'tool_call', id: 'review', name: 'submit_requirement_review', args: {
      reply: '已保存原始需求。', decision: 'clarify', agenda: [{ id: 'scope', title: '范围', kind: 'direction', status: 'open' }],
      ask: { topic_id: 'scope', kind: 'direction', question: '范围是什么？' } } })
  }
  emit({ type: 'assistant_start' })
  emit({ type: 'delta', text: '已收到。' })
  finish('已收到。')
})
`

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'ai-pm-local-platform-'))
  log('workspace: ' + root)
  const origin = join(root, 'origin.git')
  const repoPath = join(root, 'repo')
  const platformData = join(root, 'platform')
  const dataDir = join(root, 'client')
  const scenarioPath = join(root, 'scenario.json')
  const logPath = join(root, 'codex-calls.jsonl')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(root, 'clone', '-q', origin, repoPath)
  git(repoPath, 'config', 'user.email', 'test@example.com')
  git(repoPath, 'config', 'user.name', 'Test')
  writeFileSync(join(repoPath, 'README.md'), '# demo\n')
  git(repoPath, 'add', '.')
  git(repoPath, 'commit', '-q', '-m', 'init')
  git(repoPath, 'push', '-q', 'origin', 'HEAD:main')
  writeFileSync(join(root, 'worker.mjs'), WORKER)
  writeFileSync(scenarioPath, '{}')
  writeFileSync(logPath, '')
  process.env.FAKE_CODEX_SCENARIO = scenarioPath
  process.env.FAKE_CODEX_LOG = logPath
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Agent'
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'agent@example.com'
  // The next develop runs play these behaviours, in order.
  const scenario = (develop: unknown[]) => {
    rmSync(scenarioPath + '.cursor.json', { force: true })
    writeFileSync(scenarioPath, JSON.stringify({ develop }))
  }

  log('building the platform from ' + platformDir)
  const binary = join(root, 'ai-pm-server')
  execFileSync('go', ['build', '-o', binary, './cmd/server'], { cwd: platformDir, stdio: 'inherit' })
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const server = spawn(binary, ['-addr', `127.0.0.1:${port}`, '-data', platformData, '-pi-worker', join(root, 'worker.mjs'), '-sync-interval', '0'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let serverLog = ''
  server.stderr.on('data', (chunk) => (serverLog += chunk))
  let engine: Engine | null = null
  let failed = false
  try {
    await waitFor(() => fetch(base + '/api/health').then((r) => r.ok), Boolean, 'platform health', 15_000)
    log('platform: ' + base)

    // ---- the product user, through the platform's HTTP API (local mode: no login) ----
    let seq = 0
    const api = async (path: string, body?: unknown, method?: string) => {
      const response = await fetch(base + '/api' + path, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`${method ?? (body === undefined ? 'GET' : 'POST')} ${path}: ${response.status} ${text}`)
      return text ? JSON.parse(text) : {}
    }
    const remote = (id: string) => api(`/tasks/${id}`).then((v) => v.task)
    const act = async (id: string, action: string, extra: Record<string, unknown> = {}) => {
      const task = await remote(id)
      return api(`/tasks/${id}/actions`, { action, request_id: `product-${++seq}`, version: task.version, ...extra })
    }
    const verification = async (id: string, sha: string, note: string) => ({ revision: (await remote(id)).revision, sha, environment: '测试环境', note })
    const remoteStatus = (id: string, status: string, timeoutMs?: number) => waitFor(() => remote(id), (t) => t.status === status, `${id} → ${status} on the platform`, timeoutMs)
    // The test release agent would push; here the script does, then lets the platform read it.
    const publish = async (branch: string) => {
      git(repoPath, 'push', '-q', 'origin', `${branch}:${branch}`)
      await api(`/projects/${project.id}/sync`, {})
    }

    await api('/mcp', { enabled: true }, 'PUT')
    const project = await api('/projects', { name: 'v2 本机联调', repository: origin, branch: 'main', agent_read_mode: 'legacy' })
    await api(`/projects/${project.id}/sync`, {})
    // Requirements are made before a model is configured, so no review runs on them.
    const requirement = async (title: string) => {
      const { task } = await api(`/projects/${project.id}/tasks`, {
        title, kind: 'requirement', description: title + '：按描述实现', acceptance: ['功能可用', '测试通过'], request_id: 'create-' + title,
      })
      return task.id as string
    }
    const [A, B, C] = [await requirement('订单导出'), await requirement('退款统计'), await requirement('暂不需要的功能')]
    const profile = await api('/profiles', { name: '本地确定性模型', provider: 'fixture', model: 'fixture', base_url: 'http://127.0.0.1:1', api: 'openai-completions', supports_images: true })
    await api('/platform/settings', { profile_id: profile.id }, 'PUT')

    // ---- the client: settings, OAuth through the real consent form, then the engine ----
    const settings: Settings = {
      projectId: project.id, mcpUrl: base + '/mcp', resourceUri: `ai-pm://projects/${project.id}/work`, repository: origin, repoPath,
      startRef: 'origin/main', executors: { codex: { binary: FAKE_CODEX, limit: 1 } }, allowedExecutors: ['codex'],
      testReleaseInstructions: '部署测试环境并检查健康接口。', releaseInstructions: '部署生产环境并检查健康接口。', maxOpenTasks: 10,
      intakePaused: false, oauthRedirectPort: await freePort(),
      timing: {
        tickMs: 100, pollActiveMs: 1_000, pollIdleMs: 1_000, backoffMs: [200, 500, 1_000], reconnectMs: [200, 500],
        collabReportMs: 1_500, callTimeoutMs: 10_000, bindingCheckMs: 0, probeMs: 600_000,
      },
    }
    const store = new Store(join(dataDir, 'db.sqlite'))
    store.setSettings(settings)
    await login({
      store, serverUrl: settings.mcpUrl, port: settings.oauthRedirectPort, timeoutMs: 15_000,
      // Stands in for the browser: confirms the platform's own consent form.
      openBrowser: (url) => void (async () => {
        const form = new URL(url).searchParams
        form.set('decision', 'allow')
        form.set('project_id', project.id)
        const response = await fetch(base + '/oauth/authorize', { method: 'POST', body: form, redirect: 'manual' })
        await fetch(response.headers.get('location')!)
      })(),
    })
    store.close()
    check('OAuth login through registration, consent and code exchange', true)

    engine = new Engine({ dataDir })
    await engine.start()
    const local = (key: string) => engine!.store.getTask(key)
    const state = (key: string, status: string, reason?: string | null, timeoutMs?: number) =>
      waitFor(() => local(key), (t) => !!t && t.status === status && (reason === undefined || t.reason === reason), `${key} → ${status}${reason ? ':' + reason : ''}`, timeoutMs) as Promise<Task>
    const developRuns = () => engine!.store.listTasks().flatMap((t) => engine!.store.runsFor(t.key)).filter((r) => r.stage === 'develop')

    // ---- 1. requirement → plan → develop → test release ----
    scenario([])
    await act(A, 'ready')
    await state('task:' + A, 'needs_you', 'plan_confirm')
    check('claims a ready requirement and stops at plan confirmation', (await remote(A)).status === 'doing')
    await engine.command('confirmPlan', 'task:' + A, {})
    await state('task:' + A, 'needs_you', 'ready_to_test')
    await engine.command('submitTest', ['task:' + A])
    await state('task:' + A, 'waiting', 'testing')
    const submitted = await remote(A)
    check('test release submits the developed version', submitted.status === 'testing' && submitted.submission?.sha === local('task:' + A)!.data.dev?.sha, submitted.submission?.sha)

    // ---- 2. a bug against it: plan, fix on the requirement branch, returned once, verified ----
    const branch = local('task:' + A)!.branch!
    await publish(branch)
    const { task: bug } = await api(`/projects/${project.id}/tasks`, {
      title: '导出金额错位', kind: 'bug', description: '导出后金额列错位一列', acceptance: ['金额列对齐'],
      parent_requirement_id: A, parent_version: (await remote(A)).version, request_id: 'bug-1',
    })
    const X = bug.id as string
    // The platform's review readies it; the client claims it at once.
    await state('task:' + X, 'needs_you', 'plan_confirm')
    check('a filed bug is claimed and stops at plan confirmation', true)
    check('the requirement waits while its bug is open', local('task:' + A)!.status === 'waiting' && (await remote(A)).status === 'fixing')
    await engine.command('confirmPlan', 'task:' + X, {})
    const fixed = await state('task:' + X, 'needs_you', 'ready_to_test')
    check('the fix lands on the requirement branch', git(repoPath, 'rev-parse', branch) === fixed.data.dev?.sha, branch)
    await engine.command('submitTest', ['task:' + X])
    await remoteStatus(X, 'verifying')
    await state('task:' + X, 'waiting', 'testing')
    check('a submitted bug fix waits for product verification', true)

    await act(X, 'return_bug', { body: '金额仍然错位' })
    const refixed = await state('task:' + X, 'needs_you', 'ready_to_test')
    const bugRuns = engine.store.runsFor('task:' + X).filter((r) => r.stage === 'develop')
    check('a returned fix continues in its original session', bugRuns.length === 2 && bugRuns[0].sessionId === bugRuns[1].sessionId && bugRuns[1].purpose === 'continue')
    await engine.command('submitTest', ['task:' + X])
    await remoteStatus(X, 'verifying')
    await publish(branch)
    await act(X, 'verify_bug', { test_verification: await verification(X, (await remote(X)).submission.sha, '金额列已对齐') })
    await state('task:' + X, 'done')
    await remoteStatus(A, 'retest')
    check('a verified bug is done and the requirement waits for retest', local('task:' + A)!.status === 'waiting')
    check('the requirement never developed again while its bug was fixed', developRuns().filter((r) => r.taskKey === 'task:' + A).length === 1)

    // ---- 3. retest, release, acceptance ----
    const tip = git(repoPath, 'rev-parse', branch)
    await act(A, 'start_retest', { test_verification: await verification(A, tip, '包含全部修复，开始复测') })
    await act(A, 'test_pass', { test_verification: await verification(A, tip, '复测通过') })
    const ready = await state('task:' + A, 'needs_you', 'ready_to_release')
    check('ready to release with the retested version', ready.data.submittedSha === tip, tip)
    await engine.command('release', ['task:' + A])
    await state('task:' + A, 'waiting', 'acceptance')
    const deployed = await remote(A)
    check('release reports the retested version as deployed', deployed.status === 'review' && deployed.deployment?.sha === tip)
    await act(A, 'accept', { review: { revision: deployed.revision, sha: deployed.submission.sha, environment: deployed.deployment.environment, checks: deployed.acceptance.map(() => 'passed'), note: '验收通过' } })
    await state('task:' + A, 'done')
    check('acceptance on the platform finishes the requirement', true)

    // ---- 4. development alignment, then handing the claim back ----
    scenario([{ type: 'needs_alignment' }])
    await act(B, 'ready')
    await state('task:' + B, 'needs_you', 'plan_confirm')
    await engine.command('confirmPlan', 'task:' + B, {})
    await remoteStatus(B, 'aligning')
    await state('task:' + B, 'waiting', 'aligning')
    const review = await api(`/tasks/${B}/requirement-review`)
    check('an agent question becomes a platform alignment form', JSON.stringify(review).includes('"label":"退款计入哪个月？","type":"textarea"'))
    await api(`/tasks/${B}/requirement-review`, { action: 'message', request_id: 'reply-B', generation: review.generation, body: '按下单月统计' })
    await state('task:' + B, 'needs_you', 'ready_to_test')
    const resumed = await remote(B)
    check('the product reply resumes development with a new claim', resumed.status === 'doing' && engine.store.runsFor('task:' + B).some((r) => r.purpose === 'alignment'))
    await engine.command('releaseClaim', 'task:' + B, '交给别人继续')
    await remoteStatus(B, 'ready')
    await state('task:' + B, 'closed')
    await new Promise((done) => setTimeout(done, 3_000))
    check('a released requirement goes back to the pool and is not claimed again', (await remote(B)).status === 'ready' && local('task:' + B)!.status === 'closed')

    // ---- 5. closing a requirement on the user's instruction ----
    await act(C, 'ready')
    await state('task:' + C, 'needs_you', 'plan_confirm')
    await engine.command('closeRequirement', 'task:' + C, '这个需求不做了', false)
    await remoteStatus(C, 'closed')
    await state('task:' + C, 'closed')
    check('closing sends the confirmed instruction and the platform closes it', true)

    // ---- 6. a read-only collaboration from a platform conversation ----
    const run = await api(`/projects/${project.id}/runs`, { kind: 'question', prompt: '线上订单导出为什么慢？' })
    const runId = run.id ?? run.run?.id
    await waitFor(() => api(`/runs/${runId}`), (v) => (v.status ?? v.run?.status) === 'succeeded', 'question run succeeds')
    const created = await api(`/projects/${project.id}/collaborations`, { request_id: 'collab-1', origin_run_id: runId, title: '核查导出慢', brief: '看导出接口耗时', environment: '测试环境' })
    const collabId = created.collaboration.id
    await state('collaboration:' + collabId, 'done', undefined, 30_000)
    const collab = await api(`/collaborations/${collabId}`)
    const item = collab.collaboration ?? collab
    check('a collaboration is investigated and its result submitted', !!item.result || item.status === 'completed', item.status)

    // ---- nothing the client sent was refused ----
    const rejected = engine.store.listTasks().flatMap((t) => engine!.store.outboxFor(t.key)).filter((o) => o.status === 'rejected')
    const stuck = engine.store.listTasks().filter((t) => t.reason === 'platform_rejected')
    check('the platform refused none of the client’s writes', rejected.length === 0 && stuck.length === 0, JSON.stringify(stuck.map((t) => t.detail)))
    const writes = engine.store.listTasks().flatMap((t) => engine!.store.outboxFor(t.key))
    check('every write went through on its first attempt', writes.every((o) => o.status === 'done' && o.attempts === 1), `${writes.length} writes`)
    const errors = engine.store.events().filter((e) => ['platform_retry', 'platform_rejected', 'error', 'retry', 'output_invalid'].includes(e.type))
    check('no errors or retries along the way', errors.length === 0, errors.map((e) => `${e.type}: ${e.message}`).join('; '))

    await engine.stop()
    engine = null

    // ---- token refresh and the grace window, against the real token endpoint ----
    const tokenStore = new Store(join(dataDir, 'db.sqlite'))
    const before = JSON.parse(tokenStore.getSecret('oauth') ?? '{}')
    const tokens = new OAuthTokenProvider(tokenStore, settings.mcpUrl, settings.oauthRedirectPort)
    await tokens.refresh()
    const platform = new McpPlatform(settings.mcpUrl, settings.resourceUri, tokens)
    const context = await platform.call('project_get_context', {})
    await platform.close()
    check('a refreshed token keeps working', context.project?.id === project.id)
    const oldRefresh = before.tokens?.refresh_token
    if (oldRefresh) {
      const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: before.client?.client_id ?? '', resource: settings.mcpUrl })
      const replay = await fetch(base + '/oauth/token', { method: 'POST', body: form })
      check('the rotated refresh token is still redeemable inside the grace window', replay.ok, String(replay.status))
    } else {
      check('the rotated refresh token is still redeemable inside the grace window', false, 'could not read the stored refresh token')
    }
    tokenStore.close()
  } catch (error) {
    failed = true
    log('ERROR ' + (error instanceof Error ? error.stack ?? error.message : String(error)))
  } finally {
    await engine?.stop().catch(() => {})
    server.kill('SIGTERM')
    if (failed && serverLog) log('platform log (tail):\n' + serverLog.split('\n').slice(-30).join('\n'))
    if (keep) log('kept ' + root)
    else rmSync(root, { recursive: true, force: true })
  }
  const failures = checks.filter((c) => !c.ok)
  log(`${checks.length - failures.length}/${checks.length} checks passed${failed ? ', and the run stopped early' : ''}`)
  process.exit(failed || failures.length ? 1 : 0)
}

main()
