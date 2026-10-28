import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Platform } from './platform/client.js'

interface Attachment {
  id: string
  name: string
  project_id?: string
  size?: number
  mime?: string
  at?: number
}

export interface LocalAttachment extends Attachment {
  size: number
  local_path: string
  sha256: string
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function directory(path: string) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('附件目录不是普通目录：' + path)
}

function fileName(name: string): string {
  let safe = name.split(/[\\/]/).at(-1)!.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/[. ]+$/, '')
  if (!safe || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = '_' + safe
  // Leave room for UTF-8 names on filesystems with a 255-byte component limit.
  while (Buffer.byteLength(safe) > 200) safe = safe.slice(0, -1)
  return safe
}

function atomicWrite(path: string, value: string | Uint8Array) {
  const temporary = path + '.' + randomUUID() + '.tmp'
  writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 })
  renameSync(temporary, path)
}

// Context is already limited to this task. Include attachments in review
// replies and feedback as well as the original requirement; dedupe by id.
function collect(value: unknown, found = new Map<string, Attachment>()): Map<string, Attachment> {
  if (!value || typeof value !== 'object') return found
  if (Array.isArray(value)) {
    for (const item of value) collect(item, found)
  } else {
    const object = value as Record<string, any>
    if (typeof object.id === 'string' && object.id.startsWith('att_') && typeof object.name === 'string') {
      if (!/^att_[\w-]+$/.test(object.id)) throw new Error('附件 ID 无效')
      found.set(object.id, { id: object.id, name: object.name, project_id: object.project_id, size: object.size, mime: object.mime, at: object.at })
    }
    for (const item of Object.values(object)) collect(item, found)
  }
  return found
}

// Downloads complete before the executor starts. A failed download leaves
// the task queued for the existing retry flow, never an agent with half a file.
export async function syncAttachments(platform: Platform, projectId: string, cwd: string, context: unknown): Promise<{ context: unknown; attachments: LocalAttachment[] }> {
  const root = join(cwd, '.ai-pm')
  directory(root)
  const folder = join(root, 'attachments')
  directory(folder)
  const manifest = join(root, 'attachments.json')
  let cached: LocalAttachment[] = []
  try {
    if (!lstatSync(manifest).isSymbolicLink()) {
      const entries = JSON.parse(readFileSync(manifest, 'utf8')).attachments
      if (Array.isArray(entries)) cached = entries.filter((item) => item && typeof item.id === 'string' && typeof item.sha256 === 'string')
    }
  } catch { /* A missing or damaged manifest is rebuilt. */ }
  const local: LocalAttachment[] = []
  for (const attachment of collect(context).values()) {
    if (attachment.project_id && attachment.project_id !== projectId) throw new Error('附件不属于当前项目：' + attachment.id)
    if (attachment.size !== undefined && (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > 10 * 1024 * 1024)) throw new Error('附件大小无效：' + attachment.id)
    const dir = join(folder, attachment.id)
    directory(dir)
    const name = fileName(attachment.name)
    const path = join(dir, name)
    const previous = cached.find((item) => item.id === attachment.id && item.name === attachment.name && item.at === attachment.at && (attachment.size === undefined || item.size === attachment.size))
    let bytes: Uint8Array | undefined
    if (previous && existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) {
      const candidate = readFileSync(path)
      if (candidate.byteLength === previous.size && digest(candidate) === previous.sha256) bytes = candidate
    }
    if (!bytes) {
      bytes = await platform.downloadAttachment(projectId, attachment.id)
      if (attachment.size !== undefined && bytes.byteLength !== attachment.size) throw new Error('附件下载不完整：' + attachment.name)
      atomicWrite(path, bytes)
    }
    local.push({ ...attachment, size: bytes.byteLength, local_path: `.ai-pm/attachments/${attachment.id}/${name}`, sha256: digest(bytes) })
  }
  atomicWrite(manifest, JSON.stringify({ attachments: local }, null, 2))
  const annotate = (value: any): any => {
    if (Array.isArray(value)) return value.map(annotate)
    if (!value || typeof value !== 'object') return value
    const entry = local.find((a) => a.id === value.id)
    return { ...Object.fromEntries(Object.entries(value).map(([key, item]) => [key, annotate(item)])), ...(entry ? { local_path: entry.local_path, sha256: entry.sha256 } : {}) }
  }
  return { context: annotate(context), attachments: local }
}
