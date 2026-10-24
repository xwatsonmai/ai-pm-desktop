// Runs in the sandboxed renderer before the page. Exposes only a narrow bridge:
// one invoke channel for API calls and two event channels.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

const CHANNELS = new Set(['changed', 'navigate'])

contextBridge.exposeInMainWorld('api', {
  invoke: (method: string, ...args: unknown[]) => ipcRenderer.invoke('api', method, args),
  on: (channel: string, listener: (payload: unknown) => void) => {
    if (!CHANNELS.has(channel)) throw new Error('unknown channel ' + channel)
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
})
