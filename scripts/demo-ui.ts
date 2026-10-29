// Opens the real window on the fake platform with tasks in every state the
// "待你处理" page knows, for looking at the UI. Nothing touches real services.
//   npm run build && npx tsx scripts/demo-ui.ts                 # interactive
//   npm run build && npx tsx scripts/demo-ui.ts --screenshots <dir> [--theme dark|light]
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fakeExecutor, makeWorld, untilState } from '../test/helpers.js'

const argv = process.argv.slice(2)
const screenshots = argv.includes('--screenshots') ? resolve(argv[argv.indexOf('--screenshots') + 1]) : undefined
const theme = argv.includes('--theme') ? argv[argv.indexOf('--theme') + 1] : undefined
const electron = createRequire(import.meta.url)('electron') as unknown as string

// Agents report test commands verbatim; long unbroken runs must wrap.
const longTests = "go test ./internal/httpapi -run 'TestRemoteConsoleUploadsTemplateReadsAndGameResults|TestRemoteObjectProtectionAndCleanupParity|TestRemotePhoneRelayPreviewParity|TestConfirmedTemplateAssets' -count=1 通过；npm test 318 项通过。"

const planWithQuestions = {
  summary: '订单列表新增“退款中”筛选，并在导出里带上退款状态。',
  plan: '1. 订单列表筛选项增加“退款中”。\n2. 导出接口增加 refund_status 列。\n3. 补充列表与导出的测试。',
  tests: '单元测试覆盖筛选条件；导出文件人工抽查 3 条退款订单。',
  risks: '历史导出文件格式变化，下游脚本如按列号读取需要同步。',
  business_questions: [
    {
      id: 'q_month', title: '部分退款的订单算在哪个月的统计里？', description: '影响月度报表的退款金额。', kind: 'single_choice', required: true,
      options: [
        { id: 'order', label: '下单月', impact: '月报与订单月份一致，退款发生月看不到' },
        { id: 'refund', label: '退款月', impact: '月报反映实际退款时间，历史月报会变化' },
      ],
      recommended_option_ids: ['refund'],
    },
    {
      id: 'q_cols', title: '导出里需要哪些退款字段？', description: '', kind: 'multiple_choice', required: false,
      options: [
        { id: 'amount', label: '退款金额', impact: '' },
        { id: 'reason', label: '退款原因', impact: '' },
        { id: 'time', label: '退款时间', impact: '' },
      ],
      recommended_option_ids: ['amount', 'time'],
    },
    { id: 'q_note', title: '还有其他要求吗？', description: '例如导出文件名规则', kind: 'text', required: false, options: [], recommended_option_ids: [] },
  ],
  technical_findings: [
    { topic: '订单状态', conclusion: '退款状态保存在 order_refunds 表，订单表没有冗余字段。', evidence: 'server/migrations/0042_refunds.sql' },
  ],
}

async function main() {
  const world = await makeWorld({
    limit: 1,
    // All three executors are enabled for this demo project, including its reviewer.
    settings: { executors: { codex: fakeExecutor('codex'), claude: fakeExecutor('claude'), zcode: fakeExecutor('zcode') }, allowedExecutors: ['codex', 'claude', 'zcode'] },
    scenario: {
      plan: [{ type: 'result', value: planWithQuestions }, {}, {}, {}, {}, {}, { type: 'invalid' }, { type: 'invalid' }, { type: 'invalid' }, { type: 'hang', ms: 600_000 }],
      develop: [{ tests: longTests }, { type: 'needs_user' }, { tests: longTests }, { tests: longTests }, { tests: longTests }],
      test_release: [{
        type: 'result',
        value: { outcome: 'failed', deployed_sha: '', environment: '测试环境', summary: '构建失败：测试机缺少 Node 22。', verification: '', limitations: '没有部署，环境保持原样。', items: [] },
      }],
    },
  })
  const { fake, engine } = world
  const step = async (id: string, title: string, until: (key: string) => Promise<unknown>) => {
    fake.addTask(id, title)
    await until('task:' + id)
    console.log('ready:', title)
  }
  // The platform's confirmed requirement text, shown next to the plan.
  Object.assign(fake.addTask('tsk_plan', '订单列表增加退款筛选'), {
    description: '# 订单列表增加退款筛选\n\n## 目标\n运营在订单列表里按**退款状态**筛选订单，快速找到待处理的退款。\n\n## 已确认的业务规则\n1. 筛选项：全部、退款中、已退款、退款失败。\n2. 筛选结果支持导出，导出内容与列表一致。\n\n## 边界\n- 不改变退款流程本身。',
    acceptance: ['订单列表可按四种退款状态筛选', '导出结果与筛选一致', '历史订单不受影响'],
  })
  await untilState(world, 'task:tsk_plan', 'needs_you', 'plan_confirm')
  console.log('ready: 订单列表增加退款筛选')
  await step('tsk_ready', '模板列表增加状态页签', async (k) => {
    await untilState(world, k, 'needs_you', 'plan_confirm')
    await engine.command('confirmPlan', k, {})
    await untilState(world, k, 'needs_you', 'ready_to_test')
  })
  await step('tsk_ask', '对接新的短信服务商', async (k) => {
    await untilState(world, k, 'needs_you', 'plan_confirm')
    await engine.command('confirmPlan', k, {})
    await untilState(world, k, 'needs_you', 'agent_question')
  })
  await step('tsk_release', '积分商城首页改版', async (k) => {
    await untilState(world, k, 'needs_you', 'plan_confirm')
    await engine.command('confirmPlan', k, {})
    await untilState(world, k, 'needs_you', 'ready_to_test')
    await engine.command('submitTest', [k])
    await untilState(world, k, 'waiting', 'in_batch')
    await new Promise((r) => setTimeout(r, 1_500))
  })
  // Finished, with something left uncommitted in its checkout.
  await step('tsk_done', '首页轮播图换新', async (k) => {
    await untilState(world, k, 'needs_you', 'plan_confirm')
    engine.store.updateTask(k, (t) => {
      t.status = 'done'
      t.reason = null
    })
    writeFileSync(join(world.task(k).worktree!, 'notes.txt'), '临时记录\n')
  })
  // Reviewed by Claude Code instead of going to 提测.
  await step('tsk_review', '订单导出加退款状态', async (k) => {
    await untilState(world, k, 'needs_you', 'plan_confirm')
    await engine.command('confirmPlan', k, {})
    await untilState(world, k, 'needs_you', 'ready_to_test')
    await engine.command('startReview', k, 'claude')
    await untilState(world, k, 'needs_you', 'review_ready')
  })
  await step('tsk_bad', '优惠券到期提醒', (k) => untilState(world, k, 'needs_you', 'output_invalid'))
  await step('tsk_run', '会员等级规则调整', (k) => untilState(world, k, 'running'))
  // Acceptance has its own list and does not consume intake capacity.
  Object.assign(fake.addTask('tsk_acceptance', '导出功能已上线，等待产品验收'), { status: 'review' })
  engine.store.saveTask({
    ...structuredClone(world.task('task:tsk_done')),
    key: 'task:tsk_acceptance', platformId: 'tsk_acceptance', title: '导出功能已上线，等待产品验收',
    stage: 'release', status: 'waiting', reason: 'acceptance', platformStatus: 'review', worktree: null,
  })
  await engine.stop()
  Object.assign(world.fake.project, { name: '订单系统' })

  // A second project on its own platform and repository. Its agents read its own
  // scenario while it is set up; the first project's comes back afterwards.
  const own = { scenario: process.env.FAKE_CODEX_SCENARIO, log: process.env.FAKE_CODEX_LOG }
  const second = await makeWorld({ settings: { projectId: 'prj_member' } })
  Object.assign(second.fake.project, { id: 'prj_member', name: '会员系统' })
  second.fake.addTask('tsk_member', '会员积分过期提醒')
  await untilState(second, 'task:tsk_member', 'needs_you', 'plan_confirm')
  await second.engine.stop()
  process.env.FAKE_CODEX_SCENARIO = own.scenario
  process.env.FAKE_CODEX_LOG = own.log
  writeFileSync(join(world.dataDir, 'projects.json'), JSON.stringify({
    globals: { executors: world.settings.executors, allowedExecutors: world.settings.allowedExecutors },
    projects: [{ id: 'main', dataDir: world.dataDir }, { id: 'p-member', dataDir: second.dataDir }],
  }))
  console.log('ready: 会员积分过期提醒（第二个项目）')

  console.log('opening the window on', world.dataDir)
  const child = spawn(electron, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, AI_PM_DATA_DIR: world.dataDir, ...(screenshots ? { AI_PM_SCREENSHOTS: screenshots } : {}), ...(theme ? { AI_PM_THEME: theme } : {}) },
  })
  await new Promise((r) => child.on('exit', r))
  await world.dispose()
  await second.dispose()
}

void main()
