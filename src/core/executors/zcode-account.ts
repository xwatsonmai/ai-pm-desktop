// ZCode 3.16 app-server is a host protocol: unlike its TUI it does not read
// desktop OAuth or resolve account entitlements. Supply that host side here.
// Protocol reference: zai-org/ZCode, packages/services/src/model-provider and
// apps/zcode-cli/packages/bootstrap/src/zcode-protocol. Credentials stay in
// this process; never include them in settings, run requests, events or IPC.
import { createDecipheriv, createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { homedir, platform, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'

type Json = Record<string, any>
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const read = (path: string): Json => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))

// Read just package.json from Electron's ASAR, without loading the application
// archive (hundreds of MB) or starting the desktop GUI.
function desktopVersion(builtin: string): string {
  const archive = resolve(dirname(builtin), '..', '..', 'app.asar')
  const fd = openSync(archive, 'r')
  try {
    const size = Buffer.alloc(8)
    readSync(fd, size, 0, 8, 0)
    const length = size.readUInt32LE(4)
    if (length < 8 || length > 16 * 1024 * 1024) throw new Error()
    const header = Buffer.alloc(length)
    readSync(fd, header, 0, length, 8)
    const entry = JSON.parse(header.subarray(8, 8 + header.readUInt32LE(4)).toString()).files['package.json']
    if (!entry || entry.size > 256 * 1024 || !/^\d+$/.test(entry.offset)) throw new Error()
    const data = Buffer.alloc(entry.size)
    readSync(fd, data, 0, entry.size, 8 + length + Number(entry.offset))
    const version = JSON.parse(data.toString()).version
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error()
    return version
  } finally { closeSync(fd) }
}

export interface ZcodeAccountOptions {
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  fetch?: typeof globalThis.fetch
  // Injectable paths/identity keep the tests independent of real user data.
  home?: string
  identity?: string
  version?: string
}

export function createZcodeAccountBridge(options: ZcodeAccountOptions) {
  const builtin = options.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
  if (!builtin || !existsSync(builtin)) return undefined // standalone executables / older CLI
  const home = options.home ?? homedir()
  const root = join(options.env.ZCODE_DATA_BASE_DIR ?? home, '.zcode', 'v2')
  const credentialFile = join(root, 'credentials.json')
  const settingsFile = join(root, 'setting.json')
  const table = read(builtin)
  const rules: Json[] = (table.config?.providerConfigRules?.providerRules ?? []).filter((r: Json) => r.config?.access?.type === 'zhipu-account')
  const identity = options.identity ?? `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`
  const key = createHash('sha256').update(options.env.ZCODE_CREDENTIAL_SECRET?.trim() || identity).digest()
  const request = options.fetch ?? globalThis.fetch
  let active: { providerId: string; scope: string; auth: Json; refreshAt: number } | undefined
  let refreshing: Promise<Json> | undefined

  function credential(name: string): string {
    if (!existsSync(credentialFile)) return ''
    let raw: unknown
    try { raw = read(credentialFile)[name] }
    catch { throw new Error('ZCode 登录文件暂不可读，请重新获取模型') }
    if (typeof raw !== 'string') return ''
    if (!raw.startsWith('enc:v1:')) return raw.trim()
    try {
      const parts = raw.slice(7).split('.')
      if (parts.length !== 3) throw new Error()
      const [iv, tag, data] = parts.map((v) => Buffer.from(v, 'base64url'))
      const cipher = createDecipheriv('aes-256-gcm', key, iv)
      cipher.setAuthTag(tag)
      return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8').trim()
    } catch {
      throw new Error('无法读取这台电脑的 ZCode 登录，请在 ZCode 中重新登录后重试')
    }
  }

  function login() {
    let settings: Json
    try { settings = existsSync(settingsFile) ? read(settingsFile) : {} }
    catch { throw new Error('ZCode 设置暂不可读，请重新获取模型') }
    const family = settings.providerFamilyDomain
    const selection = settings.providerFamilyConnectionSelections?.[family]
    const mode = selection?.kind
    const rule = rules.find((r) => r.config.access.accountType === family && r.config.access.mode === mode)
    const oauth = family === 'bigmodel' || family === 'zai' ? credential(`oauth:${family}:access_token`) : ''
    const jwt = mode === 'start-plan' ? credential('zcodejwttoken') : ''
    const scope = hash(JSON.stringify([family, selection, oauth, jwt]))
    return { family, selection, mode, rule, oauth, jwt, scope }
  }

  async function api(url: string, authorization: string, body?: Json, headers: Record<string, string> = {}): Promise<any> {
    try {
      const response = await request(url, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: authorization, ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
      })
      if (response.status === 401 || response.status === 403) throw new Error('login')
      if (!response.ok) throw new Error('network')
      const json = await response.json() as Json
      if (json.success === false || (json.code != null && ![0, 200, '0', '200'].includes(json.code))) throw new Error('business')
      if (json.data == null) throw new Error('format')
      return json.data
    } catch (error) {
      // Remote bodies/errors can contain credentials. Return only our own text.
      if (error instanceof Error && error.message === 'login') throw new Error('ZCode 登录已失效，请重新登录后重试')
      throw new Error('读取 ZCode 账号或套餐失败，请检查网络后重新获取模型')
    }
  }

  async function prepare(expectedScope?: string): Promise<Json> {
    active = undefined
    const current = login()
    if (expectedScope && current.scope !== expectedScope) throw new Error('ZCode 登录或套餐已变化，请重试任务')
    const providers: Json = {}, states: Json = {}
    let offered: string[] | undefined
    let auth: Json | undefined
    let refreshAt = 0
    if (current.rule && (current.oauth || current.jwt)) {
      const { family, selection, mode, oauth, jwt } = current
      let version: string
      try { version = options.version ?? desktopVersion(builtin!) }
      catch { throw new Error('无法读取 ZCode 版本，请更新 ZCode 后重试') }
      if (mode === 'start-plan') {
        if (!jwt) throw new Error('ZCode 当前套餐缺少登录凭据，请重新登录后重试')
        const data = await api(`https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=${encodeURIComponent(version)}`, `Bearer ${jwt}`)
        const now = typeof data.server_time === 'number' ? data.server_time : Date.now() / 1000
        const plans = (data.plans ?? []).filter((p: Json) => p.status?.toLowerCase() === 'active' &&
          /start[- ]plan/i.test(`${p.plan_id ?? ''} ${p.name ?? ''}`) && (!Number(p.ends_at) || Number(p.ends_at) > now))
        offered = [...new Set<string>((data.balances ?? []).filter((b: Json) => plans.some((p: Json) =>
          b.user_plan_id && p.user_plan_id ? b.user_plan_id === p.user_plan_id : b.plan_id === p.plan_id))
          .flatMap((b: Json) => (b.capabilities ?? []).filter((c: string) => c.startsWith('model:')).map((c: string) => c.slice(6))))]
        // Never turn an empty Start whitelist into all bundled models.
        offered = offered.filter((id) => current.rule!.config.builtinModelIds?.includes(id))
        if (offered.length) auth = { apiKey: jwt }
        refreshAt = Date.now() + 60_000
      } else if (mode === 'individual-coding-plan' || mode === 'team-coding-plan') {
        const host = family === 'bigmodel' ? 'https://bigmodel.cn' : 'https://api.z.ai'
        const authorization = family === 'zai' ? `Bearer ${oauth}` : oauth
        const team = mode === 'team-coding-plan'
        const info = await api(`${host}/api/biz/customer/getCustomerInfo`, authorization)
        const locations = (info.organizations ?? []).flatMap((o: Json) => (o.projects ?? []).filter((p: Json) =>
          team ? String(p.projectType) === '2' && o.organizationId === selection.organizationId && p.projectId === selection.projectId
            : String(p.projectType) !== '2').map((p: Json) => ({ organizationId: o.organizationId, organizationName: o.organizationName, ...p })))
        const location = team ? locations[0] : locations.find((l: Json) => l.organizationName === '默认机构' && l.projectName === '默认项目') ?? (locations.length === 1 ? locations[0] : undefined)
        if (!location?.organizationId || !location.projectId) throw new Error('无法确定 ZCode 当前套餐项目，请在 ZCode 中重新选择套餐后重试')
        const headers: Record<string, string> = team ? { 'bigmodel-organization': location.organizationId, 'bigmodel-project': location.projectId } : {}
        if (team) {
          const subscription = await api(`${host}/api/biz/team/subscribe/product/querySubscribeDetail`, authorization, undefined, headers)
          if (!(subscription.hasSubscription === true && subscription.status === 'EFFECTIVE' && subscription.memberGrantStatus === 'VALID')) throw new Error('ZCode 当前团队套餐不可用，请在 ZCode 中确认套餐后重试')
        }
        const url = `${host}/api/biz/v1/organization/${encodeURIComponent(location.organizationId)}/projects/${encodeURIComponent(location.projectId)}/api_keys`
        const keys = await api(url, authorization, undefined, headers)
        const name = team ? 'zcode-team-api-key' : 'zcode-api-key'
        const candidates = Array.isArray(keys) ? keys.filter((k: Json) => k.name === name && (!team || k.keyType === 2)) : []
        // Reuse the native key only. Discovery must not create account resources.
        if (candidates.length !== 1 || typeof candidates[0].apiKey !== 'string') throw new Error('请先在 ZCode 中使用当前套餐发起一次会话，再重新获取模型')
        const started = Date.now()
        const token = await api(`${url}/${encodeURIComponent(candidates[0].apiKey)}/access_tokens`, `Bearer ${oauth}`, { clientType: 'zcode', clientVersion: version })
        const expires = Math.min(Number(token.expiresAt) * 1000, started + Number(token.expiresIn) * 1000)
        if (token.enable === false || token.tokenType !== 'Bearer' || typeof token.accessToken !== 'string' || !token.accessToken.trim() || !Number.isFinite(expires) || expires <= Date.now()) throw new Error('ZCode 临时凭据无效，请重新登录后重试')
        if (!team) {
          const subscriptions = await api(`${host}/api/biz/subscription/list`, token.accessToken)
          if (!Array.isArray(subscriptions) || !subscriptions.some((s: Json) => s.status === 'VALID' && s.inCurrentPeriod === true && /coding/i.test(`${s.productId ?? ''} ${s.productName ?? ''}`))) throw new Error('ZCode 当前个人套餐不可用，请在 ZCode 中确认套餐后重试')
        }
        auth = { apiKey: token.accessToken.trim(), apiKeyId: candidates[0].apiKey, accountScope: current.scope }
        refreshAt = expires - Math.min(120_000, (expires - started) / 5)
      }
    }
    // Reject results that crossed a desktop logout, account or project change.
    if (login().scope !== current.scope) throw new Error('ZCode 登录或套餐已变化，请重新获取模型')
    active = auth ? { providerId: current.rule!.providerId, scope: current.scope, auth, refreshAt } : undefined
    for (const rule of rules) {
      const entitled = !!active && rule.providerId === active.providerId
      providers[rule.providerId] = { access: { type: 'zhipu-account', entitled }, ...(entitled && offered ? { builtinModelIds: offered } : {}) }
      states[rule.providerId] = { availability: entitled ? 'available' : 'unavailable', entitled, current: entitled }
    }
    return { revision: `ai-pm:${current.scope}:${Date.now()}`, basedOnZCodeBuiltinRevision: `zcode-builtin:${table.revision ?? 0}:${hash(resolve(builtin!))}`, providers, states }
  }

  return {
    snapshot: () => prepare(),
    async headers(params: Json): Promise<Json> {
      try {
        if (refreshing) await refreshing
        const current = login()
        // A running session must not silently inherit another desktop account.
        if (!active || active.scope !== current.scope || active.providerId !== params.providerId ||
          (params.expectedAccountScope && params.expectedAccountScope !== active.scope) ||
          (params.rejectedProjectTokenFingerprint && !params.expectedAccountScope)) throw new Error('ZCode 登录或套餐已变化，请重新获取模型并重试任务')
        if (Date.now() >= active.refreshAt || (params.rejectedProjectTokenFingerprint && hash(active.auth.apiKey) === params.rejectedProjectTokenFingerprint)) {
          refreshing ??= prepare(current.scope).finally(() => { refreshing = undefined })
          await refreshing
        }
        if (!active || active.scope !== current.scope || login().scope !== current.scope) throw new Error('ZCode 登录已变化，请重试任务')
        return { headersApplied: true, requestAuth: active.auth }
      } catch (error) {
        return { headersApplied: false, errorMessage: error instanceof Error ? error.message : 'ZCode 登录读取失败' }
      }
    },
  }
}
