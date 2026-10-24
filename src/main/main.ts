// Electron shell for P1: starts the engine and shows a minimal tray. The real
// window, settings and notifications come in P3.
import { app, Menu, nativeImage, safeStorage, Tray } from 'electron'
import { Engine } from '../core/engine.js'
import type { Secrets } from '../core/store.js'
import type { Task } from '../core/types.js'

const secrets: Secrets = {
  seal: (value) => 'safe:' + safeStorage.encryptString(value).toString('base64'),
  open: (value) => (value.startsWith('safe:') ? safeStorage.decryptString(Buffer.from(value.slice(5), 'base64')) : value.replace(/^plain:/, '')),
}

let engine: Engine | null = null
let tray: Tray | null = null

function render() {
  if (!tray) return
  const tasks: Task[] = engine?.tasks() ?? []
  const needs = tasks.filter((t) => t.status === 'needs_you')
  const running = tasks.filter((t) => t.status === 'running')
  tray.setTitle(engine ? (needs.length ? `AI PM ${needs.length}` : 'AI PM') : 'AI PM 未配置')
  tray.setToolTip(`待你处理 ${needs.length} · 运行中 ${running.length}`)
  const paused = engine?.store.getSettings()?.intakePaused ?? false
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `待你处理（${needs.length}）`, enabled: false },
    ...needs.slice(0, 5).map((t) => ({ label: `  ${t.title} · ${t.reason}`, enabled: false })),
    { type: 'separator' },
    ...running.slice(0, 5).map((t) => ({ label: `运行中：${t.title}`, enabled: false })),
    { type: 'separator' },
    { label: paused ? '恢复接单' : '暂停接单', enabled: !!engine, click: () => engine?.setIntakePaused(!paused) },
    { label: '退出（运行中的轮次会继续）', click: () => app.quit() },
  ]))
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide()
  tray = new Tray(nativeImage.createEmpty())
  try {
    engine = new Engine({ dataDir: app.getPath('userData'), secrets })
    engine.on('changed', render)
    await engine.start()
  } catch (error) {
    console.error('engine not started:', error)
    engine = null
  }
  render()
})

app.on('window-all-closed', () => {
  // Keep running in the tray.
})

let stopping = false
app.on('before-quit', (event) => {
  if (stopping || !engine) return
  event.preventDefault()
  stopping = true
  void engine.stop().finally(() => app.quit())
})
