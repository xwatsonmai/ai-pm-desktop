import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { Store } from '../store.js'
import { PlatformError, type TokenProvider } from './client.js'
import { platformOAuthFetch } from './oauth-discovery.js'

// Everything OAuth keeps between runs, sealed as one secret.
interface AuthState {
  redirectUrl?: string
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens & { obtained_at: number }
  verifier?: string
  state?: string
}

export const DEFAULT_REDIRECT_PORT = 47321
const SECRET = 'oauth'
const REFRESH_MARGIN_MS = 5 * 60_000

// Login and background refresh share client registration, state and the PKCE
// verifier. Keep the complete browser round trip exclusive for this project;
// another project's authorization is independent.
const authorizations = new WeakMap<Store, Promise<void>>()

async function exclusiveAuthorization<T>(store: Store, run: () => Promise<T>): Promise<T> {
  const previous = authorizations.get(store) ?? Promise.resolve()
  const operation = previous.then(run)
  const finished = operation.then(() => {}, () => {})
  authorizations.set(store, finished)
  try {
    return await operation
  } finally {
    if (authorizations.get(store) === finished) authorizations.delete(store)
  }
}

function load(store: Store): AuthState {
  const raw = store.getSecret(SECRET)
  return raw ? (JSON.parse(raw) as AuthState) : {}
}

function save(store: Store, update: (state: AuthState) => void) {
  const state = load(store)
  update(state)
  store.setSecret(SECRET, JSON.stringify(state))
}

export function hasLogin(store: Store): boolean {
  return !!load(store).tokens?.access_token
}

// Backs the SDK's OAuth flow with our store. In background use it never opens a
// browser: needing a new login surfaces as an auth error instead.
class StoreProvider implements OAuthClientProvider {
  constructor(
    private readonly store: Store,
    private readonly redirect: string,
    private readonly onRedirect: (url: URL) => void,
  ) {
    const saved = load(store)
    if (saved.redirectUrl && saved.redirectUrl !== redirect) {
      // A client registered for another callback address cannot be reused.
      save(store, (s) => {
        s.client = undefined
        s.redirectUrl = redirect
      })
    } else if (!saved.redirectUrl) {
      save(store, (s) => (s.redirectUrl = redirect))
    }
  }

  get redirectUrl() {
    return this.redirect
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'AI PM Desktop',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp',
    }
  }

  state() {
    const value = randomBytes(16).toString('hex')
    save(this.store, (s) => (s.state = value))
    return value
  }

  clientInformation() {
    return load(this.store).client
  }

  saveClientInformation(info: OAuthClientInformationMixed) {
    save(this.store, (s) => (s.client = info))
  }

  tokens() {
    return load(this.store).tokens
  }

  saveTokens(tokens: OAuthTokens) {
    save(this.store, (s) => (s.tokens = { ...tokens, obtained_at: Date.now() }))
  }

  redirectToAuthorization(url: URL) {
    this.onRedirect(url)
  }

  saveCodeVerifier(verifier: string) {
    save(this.store, (s) => (s.verifier = verifier))
  }

  codeVerifier() {
    const verifier = load(this.store).verifier
    if (!verifier) throw new Error('missing_code_verifier')
    return verifier
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    save(this.store, (s) => {
      if (scope === 'all' || scope === 'client') s.client = undefined
      if (scope === 'all' || scope === 'tokens') s.tokens = undefined
      if (scope === 'all' || scope === 'verifier') s.verifier = undefined
    })
  }
}

export class OAuthTokenProvider implements TokenProvider {
  private refreshing: Promise<void> | null = null
  private readonly provider: StoreProvider
  private readonly fetchFn: typeof fetch

  constructor(
    private readonly store: Store,
    private readonly serverUrl: string,
    redirectPort?: number,
    fetchFn?: typeof fetch,
  ) {
    this.fetchFn = platformOAuthFetch(serverUrl, fetchFn)
    const redirect = redirectPort === undefined ? load(store).redirectUrl ?? `http://127.0.0.1:${DEFAULT_REDIRECT_PORT}/callback` : `http://127.0.0.1:${redirectPort}/callback`
    this.provider = new StoreProvider(store, redirect, () => {})
  }

  async get(): Promise<string> {
    let tokens = load(this.store).tokens
    if (!tokens?.access_token) throw new PlatformError('auth', 'login_required')
    if (tokens.expires_in && tokens.obtained_at + tokens.expires_in * 1000 - REFRESH_MARGIN_MS <= Date.now()) {
      await this.refresh()
      tokens = load(this.store).tokens
      if (!tokens?.access_token) throw new PlatformError('auth', 'login_required')
    }
    return tokens.access_token
  }

  // A lost refresh response is retried with the old refresh token; if the server
  // already rotated it, the user gets one "log in again" prompt.
  refresh(): Promise<void> {
    this.refreshing ??= exclusiveAuthorization(this.store, async () => {
      let result: string
      try {
        result = await auth(this.provider, { serverUrl: this.serverUrl, scope: 'mcp', fetchFn: this.fetchFn })
      } catch (error) {
        throw new PlatformError('retryable', 'token_refresh_failed: ' + (error instanceof Error ? error.message : String(error)))
      }
      if (result !== 'AUTHORIZED') throw new PlatformError('auth', 'login_required')
    }).finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }
}

// Interactive login: opens the authorization page and waits for the loopback callback.
interface LoginOptions {
  store: Store
  serverUrl: string
  openBrowser: (url: string) => void
  port?: number
  timeoutMs?: number
  fetchFn?: typeof fetch
  // An existing local task is owned by this public OAuth client. Reauthorize
  // that identity after moving the same project to another platform URL.
  clientId?: string
}

export function login(options: LoginOptions): Promise<void> {
  return exclusiveAuthorization(options.store, async () => {
    const previous = load(options.store)
    const rebind = !!options.clientId && previous.client?.client_id !== options.clientId
    if (rebind) {
      // Only reuse the public id, never credentials or tokens bound elsewhere.
      save(options.store, (s) => {
        s.client = { client_id: options.clientId! }
        s.tokens = undefined
        s.verifier = undefined
        s.state = undefined
      })
    }
    try {
      await interactiveLogin(options)
    } catch (error) {
      if (rebind) options.store.setSecret(SECRET, JSON.stringify(previous))
      throw error
    }
  })
}

async function interactiveLogin(options: LoginOptions): Promise<void> {
  const port = options.port ?? DEFAULT_REDIRECT_PORT
  let redirect = `http://127.0.0.1:${port}/callback`
  let callback!: (params: URLSearchParams) => void
  let fail!: (error: Error) => void
  const received = new Promise<URLSearchParams>((resolve, reject) => {
    callback = resolve
    fail = reject
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', redirect)
    if (url.pathname !== '/callback') return void res.writeHead(404).end()
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><meta charset="utf-8"><title>AI PM</title><p>登录完成，可以关闭这个页面。</p>')
    callback(url.searchParams)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error) => reject(new Error(`回调端口 ${port} 被占用：${error.message}`)))
    server.listen(port, '127.0.0.1', resolve)
  })
  // A new binding uses an OS-assigned port, independent of existing projects.
  redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`
  const timer = setTimeout(() => fail(new Error('login_timeout')), options.timeoutMs ?? 10 * 60_000)
  try {
    const provider = new StoreProvider(options.store, redirect, (url) => options.openBrowser(url.toString()))
    const fetchFn = platformOAuthFetch(options.serverUrl, options.fetchFn)
    const first = await auth(provider, { serverUrl: options.serverUrl, scope: 'mcp', fetchFn })
    if (first === 'AUTHORIZED') return
    const params = await received
    const expectedState = load(options.store).state
    if (params.get('error')) throw new Error('authorization_denied: ' + params.get('error'))
    if (!params.get('code') || (expectedState && params.get('state') !== expectedState)) throw new Error('authorization_callback_invalid')
    const second = await auth(provider, { serverUrl: options.serverUrl, scope: 'mcp', authorizationCode: params.get('code')!, fetchFn })
    if (second !== 'AUTHORIZED') throw new Error('authorization_failed')
  } finally {
    clearTimeout(timer)
    server.close()
    server.closeAllConnections()
  }
}
