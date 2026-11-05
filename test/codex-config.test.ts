import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { isCodexTrustConfig } from '../src/core/executors/codex-config.js'
import { makeWorld, untilState, type World } from './helpers.js'

let world: World | undefined
afterEach(async () => { await world?.dispose(); world = undefined })

it('accepts native Windows trust metadata and quoted paths without accepting other settings', () => {
  expect(isCodexTrustConfig(String.raw`[projects.'d:\xuan_work\ai_print\repo']
trust_level = "trusted"
`)).toBe(true)
  expect(isCodexTrustConfig('# saved by Codex\r\n[projects."C:\\\\Users\\\\Ann Lee\\\\repo"]\r\n# trust\r\ntrust_level = "trusted"\r\n\r\n[projects."/tmp/O\'Brien"]\ntrust_level = \'untrusted\'\n')).toBe(true)
  expect(isCodexTrustConfig(' # empty metadata\n')).toBe(true)
  for (const text of [
    'model = "other"', '[mcp_servers.platform]\nurl = "https://example.invalid/mcp"',
    '[projects."/repo"]\ntrust_level = "trusted"\nmodel = "other"',
    '[projects."/repo"]\ntrust_level = "trusted"\n[mcp_servers.ops]\ncommand = "anything"',
    '[projects."/repo"]\ntrust_level = "trusted"; model = "other"',
    '[projects."/repo"]\ntrust_level = "trusted"\n[hooks]\nfoo = "anything"',
    '[projects."/repo".mcp_servers.ops]\ntrust_level = "trusted"',
    '[projects."/repo"]\ntrust_level = "other"',
  ]) expect(isCodexTrustConfig(text)).toBe(false)
})

it('continues through later runs after Codex persists trust and preserves the saved file', async () => {
  world = await makeWorld()
  const key = 'task:tsk_trust'
  world.fake.addTask('tsk_trust')
  await untilState(world, key, 'needs_you', 'plan_confirm')
  const file = join(world.dataDir, 'codex-runtime', 'config.toml'), saved = readFileSync(file, 'utf8')
  expect(isCodexTrustConfig(saved)).toBe(true)
  await world.engine.command('confirmPlan', key, {})
  await untilState(world, key, 'needs_you', 'ready_to_test')
  await world.engine.command('submitTest', [key])
  await untilState(world, key, 'waiting', 'testing')
  expect(world.invocations().map(c => c.stage)).toEqual(['plan', 'develop', 'test_release'])
  expect(readFileSync(file, 'utf8')).toBe(saved)
})

it('still blocks unexpected MCP configuration and keeps it intact for inspection', async () => {
  world = await makeWorld()
  const key = 'task:tsk_config'
  world.fake.addTask('tsk_config')
  await untilState(world, key, 'needs_you', 'plan_confirm')
  const file = join(world.dataDir, 'codex-runtime', 'config.toml')
  const content = readFileSync(file, 'utf8') + '\n[mcp_servers.platform]\nurl = "https://example.invalid/mcp"\n'
  writeFileSync(file, content)
  await world.engine.command('confirmPlan', key, {})
  await untilState(world, key, 'needs_you', 'executor_failing')
  expect(world.invocations()).toHaveLength(1)
  expect(readFileSync(file, 'utf8')).toBe(content)
})
