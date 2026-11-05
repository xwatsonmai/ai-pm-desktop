import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TrackedRun } from './types.js'

export interface RunMessage { id: string; text: string; at: string }
export interface MessageReceipt { ok: boolean; error?: string }
export const messageDirectory = (logPath: string) => join(dirname(logPath), 'messages')
export const messageReady = (logPath: string) => join(messageDirectory(logPath), 'ready.json')
export function canMessage(run: TrackedRun): boolean {
  try {
    const marker = JSON.parse(readFileSync(messageReady(run.logPath), 'utf8'))
    return marker.version === 1 && marker.pid === run.pid && typeof marker.sessionId === 'string' && !!marker.sessionId
  } catch { return false }
}

// Publish complete files only. A retry keeps the same ID and cannot overwrite
// an earlier message or receipt. Everything lives in the private run directory.
export function writeOnce(file: string, value: unknown) {
  const temp = file + '.' + randomUUID() + '.tmp'
  writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
  try { linkSync(temp, file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally { unlinkSync(temp) }
}

export async function sendRunMessage(run: TrackedRun, id: string, text: string): Promise<void> {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(id)) throw Error('消息标识无效')
  if (typeof text !== 'string' || !text.trim() || text.length > 20_000) throw Error('请输入补充指令，最多 20000 字')
  const directory = messageDirectory(run.logPath)
  const file = join(directory, id + '.request.json'), reply = join(directory, id + '.receipt.json')
  if (existsSync(file)) {
    if (JSON.parse(readFileSync(file, 'utf8')).text !== text.trim()) throw Error('同一条消息不能更改内容后重发')
  } else {
    if (!canMessage(run)) throw Error('这一轮暂不支持插话；请等待执行器就绪，旧版运行需等当前轮次结束')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    // Maintain arrival order even when two sends share a millisecond or the
    // client has restarted. Requests are immutable; no in-memory queue to lose.
    const latest = Math.max(0, ...readdirSync(directory).filter(f => f.endsWith('.request.json')).map(f => Date.parse(JSON.parse(readFileSync(join(directory, f), 'utf8')).at)))
    writeOnce(file, { id, text: text.trim(), at: new Date(Math.max(Date.now(), latest + 1)).toISOString() } satisfies RunMessage)
  }
  const end = Date.now() + 12_000
  while (Date.now() < end) {
    if (existsSync(reply)) {
      const result = JSON.parse(readFileSync(reply, 'utf8')) as MessageReceipt
      if (!result.ok) throw Error(result.error ?? '补充指令发送失败')
      return
    }
    if (existsSync(join(directory, 'closed.json'))) throw Error('当前轮次已结束，补充指令未确认发送；请查看对话记录')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw Error('暂未确认发送结果，可重试同一条消息；不会重复提交')
}
