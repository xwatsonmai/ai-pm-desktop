import { createHash } from 'node:crypto'
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { syncAttachments } from '../src/core/attachments.js'
import { McpPlatform, ReadOnlyPlatform } from '../src/core/platform/client.js'
import { makeWorld, untilState, type World } from './helpers.js'
import { FakePlatform, TOKEN } from './fake-platform.js'

let world: World | null = null
let fake: FakePlatform | null = null
afterEach(async () => { await world?.dispose(); world = null; await fake?.stop(); fake = null })

const bytes = Buffer.from([0xff, 0xd8, 0, 0x80, 0xff, 0xd9])
const sha = createHash('sha256').update(bytes).digest('hex')

it('downloads originals before planning in the repository subdirectory, and reuses them for development', async () => {
  world = await makeWorld({ subdir: 'server' })
  world.fake.addTask('tsk_1')
  world.fake.attach('tsk_1', 'att_image', '图片 (1).jpg', bytes)
  await untilState(world, 'task:tsk_1', 'needs_you', 'plan_confirm')
  const plan = world.invocations()[0]
  expect(plan.cwd.endsWith('/server')).toBe(true)
  expect(plan.attachmentFiles).toEqual([{ id: 'att_image', local_path: '.ai-pm/attachments/att_image/图片 (1).jpg', size: bytes.length, sha256: sha }])
  const context = JSON.parse(readFileSync(join(plan.cwd, '.ai-pm/task.json'), 'utf8'))
  expect(context.task.attachments[0].local_path).toBe(plan.attachmentFiles[0].local_path)
  expect(readFileSync(join(plan.cwd, plan.attachmentFiles[0].local_path))).toEqual(bytes)
  await world.engine.command('confirmPlan', 'task:tsk_1', {})
  await untilState(world, 'task:tsk_1', 'needs_you', 'ready_to_test')
  expect(world.fake.attachmentRequests).toEqual(['att_image'])
  expect(world.invocations()[1].attachmentFiles[0].sha256).toBe(sha)
  expect(world.invocations()[1].prompt).toContain('.ai-pm/attachments.json')
  await world.engine.command('startReview', 'task:tsk_1', 'codex')
  await untilState(world, 'task:tsk_1', 'needs_you', 'review_ready')
  expect(world.invocations().at(-1).attachmentFiles[0].sha256).toBe(sha)
  await world.engine.command('skipReview', 'task:tsk_1')
  await untilState(world, 'task:tsk_1', 'waiting', 'testing')
  const release = world.invocations().find((r) => r.stage === 'test_release')
  expect(release.attachmentFiles[0].sha256).toBe(sha)
  expect(world.fake.attachmentRequests).toEqual(['att_image', 'att_image'])
})

it('isolates download failures, never starts that agent with missing files, and recovers on retry', async () => {
  world = await makeWorld({ limit: 2 })
  world.fake.brokenAttachments.add('att_broken')
  world.fake.addTask('tsk_1')
  world.fake.attach('tsk_1', 'att_broken', 'image.jpg', bytes)
  world.fake.addTask('tsk_2')
  await untilState(world, 'task:tsk_2', 'needs_you', 'plan_confirm')
  expect(world.task('task:tsk_1').status).toBe('queued')
  expect(world.task('task:tsk_1').lastError).toContain('附件下载失败')
  expect(world.invocations().filter((r) => r.prompt.includes('task=tsk_1]'))).toHaveLength(0)
  world.fake.brokenAttachments.clear()
  await untilState(world, 'task:tsk_1', 'needs_you', 'plan_confirm')
  expect(world.invocations().filter((r) => r.prompt.includes('task=tsk_1]'))).toHaveLength(1)
})

it('repairs a damaged cache and keeps duplicate or unsafe names inside their own attachment directories', async () => {
  world = await makeWorld()
  world.fake.addTask('tsk_1')
  world.fake.attach('tsk_1', 'att_one', '../../image.jpg', bytes)
  world.fake.attach('tsk_1', 'att_two', '..\\image.jpg', bytes)
  await untilState(world, 'task:tsk_1', 'needs_you', 'plan_confirm')
  const cwd = world.invocations()[0].cwd
  expect(existsSync(join(cwd, 'image.jpg'))).toBe(false)
  const local = join(cwd, '.ai-pm/attachments/att_one/image.jpg')
  writeFileSync(local, Buffer.alloc(bytes.length))
  await world.engine.command('revisePlan', 'task:tsk_1', '再检查附件')
  await untilState(world, 'task:tsk_1', 'needs_you', 'plan_confirm')
  expect(readFileSync(local)).toEqual(bytes)
  expect(world.fake.attachmentRequests).toEqual(['att_one', 'att_two', 'att_one'])
})

it('refuses cross-project metadata and symlink destinations, and rejects incomplete files', async () => {
  world = await makeWorld()
  const platform = world.engine.platform
  const context = { task: { attachments: [{ id: 'att_bad', name: 'file.jpg', project_id: 'other' }] } }
  await expect(syncAttachments(platform, 'prj_test', world.root, context)).rejects.toThrow('不属于当前项目')
  expect(world.fake.attachmentRequests).toHaveLength(0)
  const path = join(world.root, '.ai-pm/attachments/att_link')
  symlinkSync(world.repoPath, path, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(syncAttachments(platform, 'prj_test', world.root, { attachments: [{ id: 'att_link', name: 'file' }] })).rejects.toThrow('不是普通目录')
  world.fake.addTask('tsk_1')
  world.fake.attach('tsk_1', 'att_short', 'image.jpg', bytes)
  await expect(syncAttachments(platform, 'prj_test', world.root, { attachments: [{ id: 'att_short', name: 'image.jpg', size: bytes.length + 1 }] })).rejects.toThrow('下载不完整')
  expect(existsSync(join(world.root, '.ai-pm/attachments/att_short/image.jpg'))).toBe(false)
})

it('downloads through the mounted platform using client auth, including read-only wrappers and token refresh', async () => {
  fake = new FakePlatform('repo', '/syai/zhiqu')
  await fake.start()
  fake.addTask('t')
  fake.attach('t', 'att_binary', 'image.jpg', bytes)
  let token = 'expired'
  let refreshes = 0
  const platform = new ReadOnlyPlatform(new McpPlatform(fake.url, fake.resourceUri, { get: async () => token, refresh: async () => { refreshes++; token = TOKEN } }))
  expect(Buffer.from(await platform.downloadAttachment('prj_test', 'att_binary'))).toEqual(bytes)
  expect(refreshes).toBe(1)
  await expect(platform.downloadAttachment('other', 'att_binary')).rejects.toThrow('HTTP 403')
  await platform.close()
})
