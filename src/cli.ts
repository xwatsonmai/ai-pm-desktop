// Headless entry for development and troubleshooting:
//   tsx src/cli.ts --data <dir> init --config <settings.json> [--token-file <file>]
//   tsx src/cli.ts --data <dir> login            # OAuth in the system browser
//   tsx src/cli.ts --data <dir> probe            # read-only connection test, never writes
//   tsx src/cli.ts --data <dir> run
//   tsx src/cli.ts --data <dir> status
//   tsx src/cli.ts --data <dir> do <command> '<json array of arguments>'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Engine } from './core/engine.js'
import { login, OAuthTokenProvider } from './core/platform/oauth.js'
import { probe } from './core/probe.js'
import { Store } from './core/store.js'
import type { Settings } from './core/types.js'

function openInBrowser(url: string) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]]
  spawn(command as string, args as string[], { stdio: 'ignore', detached: true }).unref()
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function main() {
  const args = process.argv.slice(2)
  const data = option(args, '--data')
  if (!data) throw new Error('--data <dir> is required')
  const dataDir = resolve(data)
  const command = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))

  if (command === 'init') {
    const config = option(args, '--config')
    if (!config) throw new Error('--config <settings.json> is required')
    const store = new Store(resolve(dataDir, 'db.sqlite'))
    store.setSettings(JSON.parse(readFileSync(config, 'utf8')) as Settings)
    const tokenFile = option(args, '--token-file')
    if (tokenFile) store.setSecret('token', readFileSync(tokenFile, 'utf8').trim())
    store.close()
    console.log('configured', dataDir)
    return
  }

  if (command === 'login' || command === 'probe') {
    const store = new Store(resolve(dataDir, 'db.sqlite'))
    const settings = store.getSettings()
    if (!settings) throw new Error('not configured; run init first')
    try {
      if (command === 'login') {
        await login({
          store, serverUrl: settings.mcpUrl, port: settings.oauthRedirectPort,
          openBrowser: (url) => {
            console.log('请在浏览器里完成登录：\n' + url)
            openInBrowser(url)
          },
        })
        console.log('登录成功')
      } else {
        const tokens = new OAuthTokenProvider(store, settings.mcpUrl, settings.oauthRedirectPort)
        const steps = await probe(settings, tokens, Number(option(args, '--listen-seconds') ?? 15) * 1000)
        for (const s of steps) console.log(`${s.ok ? '✓' : '✗'} ${s.step}：${s.detail}`)
        if (steps.some((s) => !s.ok)) process.exitCode = 2
      }
    } finally {
      store.close()
    }
    return
  }

  const engine = new Engine({ dataDir })
  if (command === 'status') {
    for (const task of engine.tasks()) {
      console.log([task.key, task.stage, task.status, task.reason ?? '', task.title, task.lastError ?? ''].join('\t'))
    }
    engine.store.close()
    return
  }
  if (command === 'do') {
    const name = args[args.indexOf('do') + 1] as keyof Engine['commands']
    const params = JSON.parse(args[args.indexOf('do') + 2] ?? '[]') as unknown[]
    await (engine.commands[name] as (...a: unknown[]) => Promise<unknown>)(...params)
    engine.store.close()
    console.log('ok')
    return
  }
  if (command === 'run') {
    engine.on('needs_you', (task) => console.log('[needs you]', task.key, task.reason, task.detail ?? ''))
    await engine.start()
    console.log('running; Ctrl-C to stop (agent runs keep going and are picked up next start)')
    const stop = () => void engine.stop().then(() => process.exit(0))
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    return
  }
  throw new Error('unknown command: ' + command)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
