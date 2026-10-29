import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createZcodeAccountBridge } from '../src/core/executors/zcode-account.js'
import { zcodeCommand } from '../src/core/executors/zcode.js'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })); vi.unstubAllEnvs() })
const PROVIDER = 'account:bigmodel-individual-coding-plan'
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'ai-pm-zcode-auth-')); roots.push(home)
  const root = join(home, '.zcode', 'v2'); mkdirSync(root, { recursive: true })
  const builtin = join(home, 'resources', 'config', 'provider', 'zcode-builtin.json')
  mkdirSync(join(home, 'resources', 'config', 'provider'), { recursive: true })
  const rules = ['individual-coding-plan', 'team-coding-plan', 'start-plan'].map((mode) => ({ providerId: `account:bigmodel-${mode}`, config: { access: { type: 'zhipu-account', accountType: 'bigmodel', mode }, builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'] } }))
  writeFileSync(builtin, JSON.stringify({ revision: 33, config: { providerConfigRules: { providerRules: rules } } }))
  const settings = join(root, 'setting.json'), credentials = join(root, 'credentials.json')
  const select = (kind = 'individual-coding-plan', projectId = 'project') => writeFileSync(settings, JSON.stringify({ providerFamilyDomain: 'bigmodel', providerFamilyConnectionSelections: { bigmodel: { kind, organizationId: 'org', projectId } } }))
  select()
  const identity = 'test-device-secret'
  const encrypt = (value: string) => {
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', createHash('sha256').update(identity).digest(), iv)
    const data = Buffer.concat([c.update(value), c.final()])
    return 'enc:v1:' + [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.')
  }
  const login = (token = 'FAKE_OAUTH', jwt = 'FAKE_JWT') => writeFileSync(credentials, JSON.stringify({ 'oauth:bigmodel:access_token': encrypt(token), zcodejwttoken: encrypt(jwt) }))
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    let data: unknown
    if (url.endsWith('/getCustomerInfo')) data = { organizations: [{ organizationId: 'org', projects: [{ projectId: 'project', projectType: 1 }, { projectId: 'team', projectType: 2 }] }] }
    else if (url.endsWith('/api_keys')) data = [{ apiKey: 'key-id', name: 'zcode-api-key' }, { apiKey: 'team-key', name: 'zcode-team-api-key', keyType: 2 }]
    else if (url.endsWith('/access_tokens')) data = { accessToken: 'FAKE_PAT', tokenType: 'Bearer', expiresAt: Date.now() / 1000 + 3600, expiresIn: 3600, enable: true }
    else if (url.endsWith('/subscription/list')) data = [{ productName: 'Coding Plan', status: 'VALID', inCurrentPeriod: true }]
    else if (url.endsWith('/querySubscribeDetail')) data = { hasSubscription: true, status: 'EFFECTIVE', memberGrantStatus: 'VALID' }
    else throw new Error('Unexpected endpoint ' + url)
    return new Response(JSON.stringify({ code: 200, data }))
  })
  const env = { ZCODE_DATA_BASE_DIR: home, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin }
  const bridge = (version: string | undefined = '3.16.3') => createZcodeAccountBridge({ env, home, identity, fetch: request, version })!
  return { home, root, builtin, env, settings, credentials, select, encrypt, login, request, bridge }
}

it('retries after desktop login; synchronizes exact registry revision without changing native files', async () => {
  const f = setup(), bridge = f.bridge()
  const empty = await bridge.snapshot()
  expect(Object.values(empty.providers).every((p: any) => !p.access.entitled)).toBe(true)
  expect(f.request).not.toHaveBeenCalled()
  f.login()
  const original = readFileSync(f.credentials, 'utf8'), settings = readFileSync(f.settings, 'utf8')
  const snapshot = await bridge.snapshot()
  expect(snapshot.providers[PROVIDER].access.entitled).toBe(true)
  expect(Object.values(snapshot.providers).filter((p: any) => p.access.entitled)).toHaveLength(1)
  expect(snapshot.basedOnZCodeBuiltinRevision).toBe('zcode-builtin:33:' + createHash('sha256').update(resolve(f.builtin)).digest('hex'))
  const headers = await bridge.headers({ providerId: PROVIDER })
  expect(headers).toMatchObject({ headersApplied: true, requestAuth: { apiKey: 'FAKE_PAT', apiKeyId: 'key-id' } })
  expect(JSON.stringify(snapshot)).not.toMatch(/FAKE_|key-id/)
  expect(readFileSync(f.credentials, 'utf8')).toBe(original)
  expect(readFileSync(f.settings, 'utf8')).toBe(settings)
  expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST').map(([u]) => String(u))).toEqual([expect.stringMatching(/\/key-id\/access_tokens$/)])
  expect(JSON.parse(String(f.request.mock.calls.find(([u]) => String(u).endsWith('/access_tokens'))![1]!.body))).toEqual({ clientType: 'zcode', clientVersion: '3.16.3' })
})

it('does not infer entitlement from login or select a different native project/key', async () => {
  const f = setup(); f.login()
  f.request.mockImplementationOnce(async () => new Response(JSON.stringify({ code: 200, data: { organizations: [{ organizationId: 'org', projects: [{ projectId: 'a' }, { projectId: 'b' }] }] } })))
  await expect(f.bridge().snapshot()).rejects.toThrow('无法确定')
  expect(f.request).toHaveBeenCalledTimes(1)
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (u, init) => String(u).endsWith('/subscription/list') ? new Response(JSON.stringify({ code: 200, data: [{ productName: 'Coding', status: 'EXPIRED', inCurrentPeriod: false }] })) : original(u, init))
  const b = f.bridge()
  await expect(b.snapshot()).rejects.toThrow('套餐不可用')
  expect((await b.headers({ providerId: PROVIDER })).headersApplied).toBe(false)
})

it('retries failed auth/network requests and never returns remote bodies or secrets', async () => {
  const f = setup(); f.login(); const b = f.bridge()
  f.request.mockResolvedValueOnce(new Response('FAKE_SECRET_DIAGNOSTICS', { status: 401 }))
  await expect(b.snapshot()).rejects.toThrow('登录已失效')
  f.request.mockRejectedValueOnce(new Error('https://host?token=FAKE_SECRET'))
  await expect(b.snapshot()).rejects.toThrow('检查网络')
  expect((await b.snapshot()).providers[PROVIDER].access.entitled).toBe(true)
  writeFileSync(f.credentials, 'FAKE_SECRET_BAD_JSON')
  await expect(b.snapshot()).rejects.toThrow('登录文件暂不可读')
  writeFileSync(f.credentials, JSON.stringify({ 'oauth:bigmodel:access_token': 'enc:v1:invalid' }))
  await expect(b.snapshot()).rejects.toThrow('重新登录')
})

it('rejects account/project changes, including a change during entitlement IO', async () => {
  const f = setup(); f.login(); const b = f.bridge(); await b.snapshot()
  expect((await b.headers({ providerId: 'another-provider' })).headersApplied).toBe(false)
  expect((await b.headers({ providerId: PROVIDER, expectedAccountScope: 'old-account' })).headersApplied).toBe(false)
  f.login('DIFFERENT_ACCOUNT')
  expect((await b.headers({ providerId: PROVIDER })).headersApplied).toBe(false)
  const request = f.request.getMockImplementation()!
  f.request.mockImplementation(async (u, init) => { const result = await request(u, init); if (String(u).endsWith('/subscription/list')) f.select('team-coding-plan', 'team'); return result })
  await expect(f.bridge().snapshot()).rejects.toThrow('已变化')
})

it('coalesces rejected PAT refresh and pins runtime authentication to the original account scope', async () => {
  const f = setup(); f.login(); const b = f.bridge(); await b.snapshot()
  const first = await b.headers({ providerId: PROVIDER })
  const rejection = { providerId: PROVIDER, expectedAccountScope: first.requestAuth.accountScope, rejectedProjectTokenFingerprint: createHash('sha256').update('FAKE_PAT').digest('hex') }
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (u, init) => String(u).endsWith('/access_tokens') ? new Response(JSON.stringify({ code: 200, data: { accessToken: 'NEW_PAT', tokenType: 'Bearer', expiresAt: Date.now() / 1000 + 3600, expiresIn: 3600 } })) : original(u, init))
  expect((await Promise.all([b.headers(rejection), b.headers(rejection)])).map((r) => r.requestAuth?.apiKey)).toEqual(['NEW_PAT', 'NEW_PAT'])
  expect(f.request.mock.calls.filter(([u]) => String(u).endsWith('/access_tokens'))).toHaveLength(2)
  expect((await b.headers({ providerId: PROVIDER, rejectedProjectTokenFingerprint: rejection.rejectedProjectTokenFingerprint })).headersApplied).toBe(false)
})

it('checks the selected team membership and subscription before minting a project token', async () => {
  const f = setup(); f.login(); f.select('team-coding-plan', 'team'); const b = f.bridge()
  const snap = await b.snapshot()
  expect(snap.providers['account:bigmodel-team-coding-plan'].access.entitled).toBe(true)
  const team = f.request.mock.calls.find(([u]) => String(u).endsWith('/querySubscribeDetail'))!
  expect(team[1]?.headers).toMatchObject({ 'bigmodel-organization': 'org', 'bigmodel-project': 'team' })
  f.select('team-coding-plan', 'removed-team')
  await expect(f.bridge().snapshot()).rejects.toThrow('无法确定')
})

it('keeps an empty Start Plan whitelist empty and intersects entitlement models with the bundled catalog', async () => {
  const f = setup(); f.login(); f.select('start-plan')
  f.request.mockImplementation(async () => new Response(JSON.stringify({ code: 0, data: { plans: [{ plan_id: 'zcode-v3-start-plan', status: 'active' }], balances: [{ plan_id: 'zcode-v3-start-plan', capabilities: ['model:GLM-5.3-Flash', 'model:NOT_ENTITLED_IN_CATALOG'] }] } })))
  const b = f.bridge(), snapshot = await b.snapshot()
  expect(snapshot.providers['account:bigmodel-start-plan']).toMatchObject({ builtinModelIds: ['GLM-5.3-Flash'], access: { entitled: true } })
  expect((await b.headers({ providerId: 'account:bigmodel-start-plan' })).requestAuth.apiKey).toBe('FAKE_JWT')
  f.request.mockImplementation(async () => new Response(JSON.stringify({ code: 0, data: { plans: [], balances: [] } })))
  expect((await b.snapshot()).providers['account:bigmodel-start-plan'].access.entitled).toBe(false)
})

it('pins both provider paths when invoking a bundled CLI and leaves standalone executables alone', () => {
  const f = setup(), binary = join(f.home, 'resources', 'glm', 'zcode.cjs')
  vi.stubEnv('ZCODE_DATA_BASE_DIR', f.home)
  const { env } = zcodeCommand({ binary, runtime: 'ZCode.exe', limit: 1 })
  expect(env).toMatchObject({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: f.builtin, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(f.root, 'provider_config.json'), ZCODE_APP_SERVER_AUTH_MODE: 'host', ELECTRON_RUN_AS_NODE: '1' })
  expect(createZcodeAccountBridge({ env: {} })).toBeUndefined()
})
