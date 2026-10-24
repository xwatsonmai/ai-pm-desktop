// Electron shell: one window, a tray icon, system notifications. All behaviour
// lives in AppController; this file only wires it to Electron.
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, shell, Tray } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Secrets } from '../core/store.js'
import { API_METHODS, type ApiMethod, type Route } from '../shared/api.js'
import { AppController, type Notice } from './controller.js'

const here = dirname(fileURLToPath(import.meta.url))
const screenshots = process.env.AI_PM_SCREENSHOTS // verification mode: capture each page, then quit

const secrets: Secrets = {
  seal: (value) => (safeStorage.isEncryptionAvailable() ? 'safe:' + safeStorage.encryptString(value).toString('base64') : 'plain:' + value),
  open: (value) => (value.startsWith('safe:') ? safeStorage.decryptString(Buffer.from(value.slice(5), 'base64')) : value.replace(/^plain:/, '')),
}

let controller: AppController
let window: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

if (!app.requestSingleInstanceLock()) {
  // Two engines on one database would schedule the same work twice.
  app.quit()
}

function createWindow() {
  window = new BrowserWindow({
    width: 1240, height: screenshots ? 1700 : 820, minWidth: 920, minHeight: 600, title: 'AI PM', show: !screenshots,
    // The sidebar runs under the macOS traffic lights, as in other native-feeling apps.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5',
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  void window.loadFile(join(here, '..', 'renderer', 'index.html'))
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault() // closing the window keeps the client running in the tray
    window?.hide()
  })
}

function show(route?: Route) {
  if (!window) createWindow()
  window!.show()
  window!.focus()
  if (route) window!.webContents.send('navigate', route)
}

async function renderTray() {
  if (!tray || quitting) return
  const snapshot = await controller.snapshot()
  const needs = snapshot.tasks.filter((t) => t.status === 'needs_you')
  const running = snapshot.tasks.filter((t) => t.status === 'running')
  tray.setTitle(needs.length ? `AI PM ${needs.length}` : 'AI PM')
  tray.setToolTip(`待你处理 ${needs.length} · 运行中 ${running.length}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => show() },
    { label: `待你处理（${needs.length}）`, click: () => show({ page: 'needs' }) },
    ...running.slice(0, 5).map((t) => ({ label: `运行中：${t.title}`, click: () => show({ page: 'task', key: t.key, tab: 'log' }) })),
    { type: 'separator' },
    { label: snapshot.engine.intakePaused ? '恢复接单' : '暂停接单', enabled: snapshot.configured, click: () => controller.setIntakePaused(!snapshot.engine.intakePaused).catch((error: Error) => {
        new Notification({ title: '没有恢复接单', body: error.message }).show()
      }) },
    { label: '退出（运行中的轮次会继续，下次启动时接回）', click: () => app.quit() },
  ]))
  if (process.platform === 'darwin') app.dock?.setBadge(needs.length ? String(needs.length) : '')
}

// Several needs_you events in a burst become one notification.
let pending: Notice[] = []
let flushTimer: NodeJS.Timeout | null = null
function notify(notice: Notice) {
  pending.push(notice)
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    const batch = pending
    pending = []
    flushTimer = null
    if (!Notification.isSupported() || screenshots) return
    const single = batch.length === 1 ? batch[0] : null
    const notification = new Notification({
      title: single ? single.title : `${batch.length} 件事需要你处理`,
      body: single ? single.body : batch.map((n) => `${n.title}：${n.body}`).join('\n'),
    })
    notification.on('click', () => show(single?.key ? { page: 'task', key: single.key } : { page: 'needs' }))
    notification.show()
  }, 1_500)
}

function applicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' }, // copy and paste shortcuts in text fields
    {
      label: '前往',
      submenu: [
        { label: '待你处理', accelerator: 'CmdOrCtrl+1', click: () => show({ page: 'needs' }) },
        { label: '全部任务', accelerator: 'CmdOrCtrl+2', click: () => show({ page: 'tasks' }) },
        { label: '设置', accelerator: 'CmdOrCtrl+,', click: () => show({ page: 'settings' }) },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]))
}

async function captureAll() {
  const out = screenshots!
  mkdirSync(out, { recursive: true })
  const snapshot = await controller.snapshot()
  const first = snapshot.tasks.find((t) => t.dev) ?? snapshot.tasks.find((t) => t.status === 'needs_you') ?? snapshot.tasks[0]
  const routes: [string, Route][] = [['needs', { page: 'needs' }], ['tasks', { page: 'tasks' }], ['settings', { page: 'settings' }]]
  const batch = snapshot.tasks.find((t) => t.kind === 'batch')
  if (batch) routes.push(['batch', { page: 'task', key: batch.key, tab: 'progress' }])
  if (first) {
    routes.push(['detail-progress', { page: 'task', key: first.key, tab: 'progress' }])
    routes.push(['detail-log', { page: 'task', key: first.key, tab: 'log' }])
    routes.push(['detail-plan', { page: 'task', key: first.key, tab: 'plan' }])
    routes.push(['detail-diff', { page: 'task', key: first.key, tab: 'diff' }])
  }
  for (const [name, route] of routes) {
    window!.webContents.send('navigate', route)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    // Long pages are captured in screen-sized slices.
    const pages = await window!.webContents.executeJavaScript(
      'Math.min(6, Math.ceil(document.querySelector(".main").scrollHeight / window.innerHeight))') as number
    for (let i = 0; i < pages; i++) {
      await window!.webContents.executeJavaScript(`document.querySelector(".main").scrollTo(0, ${i} * window.innerHeight * 0.9)`)
      await new Promise((resolve) => setTimeout(resolve, 200))
      const image = await window!.webContents.capturePage()
      writeFileSync(join(out, `${name}${i ? '-' + (i + 1) : ''}.png`), image.toPNG())
    }
  }
  quitting = true
  app.quit()
}

const theme = process.env.AI_PM_THEME
if (theme === 'dark' || theme === 'light') nativeTheme.themeSource = theme

app.whenReady().then(async () => {
  controller = new AppController(process.env.AI_PM_DATA_DIR ?? app.getPath('userData'), secrets, {
    openExternal: (url) => void shell.openExternal(url),
    openPath: (path) => void shell.openPath(path),
    copy: (text) => clipboard.writeText(text),
  })
  ipcMain.handle('api', (_event, method: ApiMethod, args: unknown[]) => {
    if (!API_METHODS.includes(method)) throw new Error('unknown api method ' + method)
    if (quitting) throw new Error('shutting_down')
    return (controller[method] as (...a: unknown[]) => Promise<unknown>)(...args)
  })
  controller.on('changed', () => {
    window?.webContents.send('changed')
    void renderTray()
  })
  controller.on('notice', notify)
  applicationMenu()
  tray = new Tray(nativeImage.createEmpty())
  tray.on('click', () => show())
  createWindow()
  try {
    await controller.start()
  } catch (error) {
    console.error('engine not started:', error)
  }
  await renderTray()
  if (screenshots) window!.webContents.once('did-finish-load', () => void captureAll())
  if (screenshots && !window!.webContents.isLoading()) void captureAll()
})

app.on('second-instance', () => show())
app.on('activate', () => show())
app.on('window-all-closed', () => {
  // Keep running in the tray.
})
app.on('before-quit', (event) => {
  if (!controller || (quitting && !controller.engine)) return
  event.preventDefault()
  quitting = true
  void controller.stop().finally(() => {
    controller.engine = null
    app.quit()
  })
})
