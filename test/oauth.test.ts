import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js'
import { McpPlatform, PlatformError, ReadOnlyPlatform } from '../src/core/platform/client.js'
import { hasLogin, login, OAuthTokenProvider } from '../src/core/platform/oauth.js'
import { platformOAuthFetch } from '../src/core/platform/oauth-discovery.js'
import { probe } from '../src/core/probe.js'
import { Store } from '../src/core/store.js'
import type { Settings } from '../src/core/types.js'
import { FakePlatform } from './fake-platform.js'

let fake: FakePlatform
let store: Store
let root: string

afterEach(async () => {
  store?.close()
  store = undefined!
  await fake?.stop()
  fake = undefined!
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined!
})

const port = () => 47_400 + Math.floor(Math.random() * 500)

// Plays the user's browser: follows the authorization redirect to the loopback callback.
async function browser(url: string) {
  const response = await fetch(url, { redirect: 'manual' })
  const location = response.headers.get('location')
  if (!location) throw new Error('no redirect from authorize: ' + response.status)
  await fetch(location)
}

async function setup(basePath = '') {
  root = mkdtempSync(join(tmpdir(), 'ai-pm-oauth-'))
  fake = new FakePlatform('repo', basePath)
  await fake.start()
  store = new Store(join(root, 'data', 'db.sqlite'))
}

describe('OAuth login', () => {
  it('reauthorizes an existing claim owner instead of keeping a newly registered identity', async () => {
    await setup('/syai/zhiqu')
    const callbackPort = port()
    const signIn = () => login({ store, serverUrl: fake.url, port: callbackPort, openBrowser: (url) => void browser(url) })
    await signIn()
    const original = JSON.parse(store.getSecret('oauth')!)
    store.setSecret('oauth', '{}')
    await signIn()
    const replacement = JSON.parse(store.getSecret('oauth')!)
    expect(replacement.client.client_id).not.toBe(original.client.client_id)
    let opened = ''
    await login({ store, serverUrl: fake.url, port: callbackPort, clientId: original.client.client_id, openBrowser: (url) => {
      opened = url
      void browser(url)
    } })
    expect(new URL(opened).searchParams.get('client_id')).toBe(original.client.client_id)
    const restored = JSON.parse(store.getSecret('oauth')!)
    expect(restored.client.client_id).toBe(original.client.client_id)
    expect(restored.tokens.access_token).not.toBe(replacement.tokens.access_token)
    // Cancelling an identity change preserves the currently working login.
    await expect(login({ store, serverUrl: fake.url, port: callbackPort, clientId: replacement.client.client_id, openBrowser: (url) => {
      const callback = new URL(new URL(url).searchParams.get('redirect_uri')!)
      callback.searchParams.set('error', 'access_denied')
      void fetch(callback)
    } })).rejects.toThrow('authorization_denied')
    expect(JSON.parse(store.getSecret('oauth')!)).toEqual(restored)
  })

  it('keeps a background refresh from replacing an in-progress browser login', async () => {
    await setup()
    const callbackPort = port()
    let refreshed: Promise<unknown> | undefined
    let browserError: unknown
    await login({ store, serverUrl: fake.url, port: callbackPort, openBrowser: (url) => {
      void (async () => {
        const response = await fetch(url, { redirect: 'manual' })
        const location = response.headers.get('location')!
        refreshed = new OAuthTokenProvider(store, fake.url, callbackPort).refresh().catch((error) => error)
        // Without serialization refresh enters another authorization flow before
        // this browser returns, replacing both its state and its PKCE verifier.
        await Promise.race([refreshed, new Promise((resolve) => setTimeout(resolve, 200))])
        await fetch(location)
      })().catch((error) => { browserError = error })
    } })
    expect(browserError).toBeUndefined()
    expect(await refreshed).toBeUndefined()
    expect(hasLogin(store)).toBe(true)
    expect(fake.tokenRequests.map((r) => r.grant_type)).toEqual(['authorization_code', 'refresh_token'])
  })

  it('allows another login after the browser denies an earlier attempt', async () => {
    await setup()
    const callbackPort = port()
    await expect(login({ store, serverUrl: fake.url, port: callbackPort, openBrowser: (url) => {
      const callback = new URL(new URL(url).searchParams.get('redirect_uri')!)
      callback.searchParams.set('error', 'access_denied')
      void fetch(callback)
    } })).rejects.toThrow('authorization_denied: access_denied')
    await login({ store, serverUrl: fake.url, port: callbackPort, openBrowser: (url) => void browser(url) })
    expect(hasLogin(store)).toBe(true)
  })

  it('discovers a mounted platform, logs in with PKCE, and refreshes after restarting the provider', async () => {
    await setup('/syai/zhiqu')
    fake.tokenLifetimeSeconds = 60
    const callbackPort = port()
    const requests: { url: string; method: string }[] = []
    const fetchFn: typeof fetch = (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? 'GET' })
      return fetch(input, init)
    }
    let opened = ''
    await login({ store, serverUrl: fake.url, port: callbackPort, fetchFn, openBrowser: (url) => {
      opened = url
      void browser(url)
    } })
    const base = fake.url.slice(0, -'/mcp'.length)
    expect(opened.startsWith(base + '/oauth/authorize?')).toBe(true)
    expect(new URL(opened).searchParams.get('resource')).toBe(fake.url)
    const first = JSON.parse(store.getSecret('oauth')!).tokens.access_token
    const provider = new OAuthTokenProvider(store, fake.url, callbackPort, fetchFn)
    expect(await provider.get()).not.toBe(first)
    expect(fake.tokenRequests).toEqual([
      { grant_type: 'authorization_code', resource: fake.url },
      { grant_type: 'refresh_token', resource: fake.url },
    ])
    expect(requests.filter((r) => r.method === 'POST').every((r) => r.url.startsWith(base + '/oauth/'))).toBe(true)
    expect(requests.some((r) => r.url === base + '/.well-known/oauth-authorization-server')).toBe(true)
    // OAuth metadata must not be parsed as OIDC (the platform has no jwks_uri).
    expect(requests.some((r) => r.url.includes('openid-configuration'))).toBe(false)
    const platform = new McpPlatform(fake.url, fake.resourceUri, provider, 5_000)
    try {
      expect((await platform.call('project_get_context', {})).project.id).toBe('prj_test')
    } finally {
      await platform.close()
    }
  })

  it('prefers standard metadata when it exists for a mounted resource', async () => {
    const server = 'https://example.test/syai/zhiqu/mcp'
    const issuer = 'https://example.test/identity/team'
    const requests: string[] = []
    const fetchFn: typeof fetch = async (input) => {
      requests.push(String(input))
      if (String(input).includes('oauth-protected-resource')) return Response.json({ resource: server, authorization_servers: [issuer] })
      return Response.json({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', response_types_supported: ['code'] })
    }
    const info = await discoverOAuthServerInfo(server, { fetchFn: platformOAuthFetch(server, fetchFn) })
    expect(info.authorizationServerUrl).toBe(issuer)
    expect(requests).toEqual([
      'https://example.test/.well-known/oauth-protected-resource/syai/zhiqu/mcp',
      'https://example.test/.well-known/oauth-authorization-server/identity/team',
    ])
  })

  it.each([401, 500])('does not hide a metadata HTTP %i by trying another endpoint', async (status) => {
    const server = 'https://example.test/syai/zhiqu/mcp'
    const requests: string[] = []
    const fetchFn: typeof fetch = async (input) => {
      requests.push(String(input))
      return new Response('unavailable', { status })
    }
    const response = await platformOAuthFetch(server, fetchFn)('https://example.test/.well-known/oauth-protected-resource/syai/zhiqu/mcp')
    expect(response.status).toBe(status)
    expect(requests).toHaveLength(1)
  })

  it('logs in through the browser with PKCE and calls the platform with the issued token', async () => {
    await setup()
    const callbackPort = port()
    let opened = ''
    await login({ store, serverUrl: fake.url, port: callbackPort, openBrowser: (url) => {
      opened = url
      void browser(url)
    } })
    expect(opened).toContain('code_challenge_method=S256')
    expect(hasLogin(store)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(join(root, 'data', 'db.sqlite')).mode & 0o777).toBe(0o600)
    const platform = new McpPlatform(fake.url, fake.resourceUri, new OAuthTokenProvider(store, fake.url, callbackPort), 5_000)
    const context = await platform.call('project_get_context', {})
    expect(context.project.id).toBe('prj_test')
    await platform.close()
  })

  it('refreshes a token that is about to expire, rotating the refresh token', async () => {
    await setup()
    fake.tokenLifetimeSeconds = 60 // inside the 5-minute refresh margin
    const callbackPort = port()
    await login({ store, serverUrl: fake.url, port: callbackPort, openBrowser: (url) => void browser(url) })
    const tokens = new OAuthTokenProvider(store, fake.url, callbackPort)
    const first = JSON.parse(store.getSecret('oauth')!).tokens.access_token
    const refreshed = await tokens.get()
    expect(refreshed).not.toBe(first)
    expect(fake.tokenRequests.map((r) => r.grant_type)).toEqual(['authorization_code', 'refresh_token'])
  })

  it('asks for a new login when the refresh token is no longer valid', async () => {
    await setup()
    fake.tokenLifetimeSeconds = 60
    const callbackPort = port()
    await login({ store, serverUrl: fake.url, port: callbackPort, openBrowser: (url) => void browser(url) })
    fake.revokeAllRefreshTokens()
    const error = await new OAuthTokenProvider(store, fake.url, callbackPort).get().catch((e) => e)
    expect(error).toBeInstanceOf(PlatformError)
    expect(error.kind).toBe('auth')
    expect(error.message).toBe('login_required')
  })
})

describe('read-only connection test', () => {
  it('refuses writes before they leave the process', async () => {
    await setup()
    fake.addTask('tsk_1')
    const platform = new ReadOnlyPlatform(new McpPlatform(fake.url, fake.resourceUri, { get: async () => 'test-token', refresh: async () => {} }, 5_000))
    const error = await platform.call('task_claim', { task_id: 'tsk_1', request_id: 'r' }).catch((e) => e)
    expect(error.message).toBe('read_only_mode: task_claim')
    expect(fake.calls).toHaveLength(0)
    expect(fake.tasks.get('tsk_1')!.status).toBe('ready')
    await platform.close()
  })

  it('reports login, binding, work list and subscription without writing anything', async () => {
    await setup()
    const repoPath = join(root, 'repo')
    execFileSync('git', ['init', '-q', repoPath])
    execFileSync('git', ['remote', 'add', 'origin', 'http://git.example/team/app.git'], { cwd: repoPath })
    fake.project.repository = 'git@git.example:team/app.git'
    fake.addTask('tsk_1')
    const callbackPort = port()
    await login({ store, serverUrl: fake.url, port: callbackPort, openBrowser: (url) => void browser(url) })
    const settings = {
      projectId: 'prj_test', mcpUrl: fake.url, resourceUri: fake.resourceUri, repository: 'http://git.example/team/app.git',
      repoPath, startRef: 'origin/main', executors: {}, allowedExecutors: [], testReleaseInstructions: '', releaseInstructions: '', maxOpenTasks: 1,
    } satisfies Settings
    const steps = await probe(settings, new OAuthTokenProvider(store, fake.url, callbackPort), 300)
    expect(steps.map((s) => [s.step, s.ok])).toEqual([
      ['登录', true], ['project_get_context', true], ['错误码', true], ['本地仓库', true], ['work_list', true], ['task_get_context', true], ['订阅', true],
    ])
    expect(fake.calls.map((c) => c.tool)).toEqual(['project_get_context', 'task_get_context', 'work_list', 'task_get_context'])
    expect(fake.tasks.get('tsk_1')!.status).toBe('ready')

    // A platform without error codes fails only that step.
    fake.legacyErrors = true
    const legacy = await probe(settings, new OAuthTokenProvider(store, fake.url, callbackPort), 300)
    expect(legacy.filter((s) => !s.ok).map((s) => s.step)).toEqual(['错误码'])
  })
})
