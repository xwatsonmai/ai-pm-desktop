import type { LogEntry } from '../shared/api.js'
import type { ExecutorName } from '../core/types.js'
import { mergeEntries } from '../shared/log.js'
import { codexEntries } from './codex-log.js'

const clip = (text: string, max = 6_000) => (text.length > max ? text.slice(0, max) + `\n…（还有 ${text.length - max} 个字符）` : text)

// One tool call as a log entry: shell commands and file edits get their own shapes.
function toolEntry(id: string, name: string, input: any): LogEntry {
  if (name === 'Bash') return { id, kind: 'command', text: String(input?.command ?? ''), running: true }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return { id, kind: 'files', text: `修改 ${input?.file_path ?? input?.notebook_path ?? ''}` }
  const subject = input?.file_path ?? input?.path ?? input?.pattern ?? input?.url ?? input?.query ?? ''
  return { id, kind: 'command', text: `${name}${subject ? ' ' + subject : ''}`, running: true }
}

// `claude -p --output-format stream-json --verbose` events.
// A tool call's result, filled into the call's entry (which may be in an earlier chunk).
function finished(id: string, output: string, exitCode: number): LogEntry {
  return { id, kind: 'command', text: '', running: false, output: output ? clip(output) : undefined, exitCode, merge: 'patch' }
}

// `base` keeps ids unique across the chunks a running log is read in.
export function claudeEntries(events: any[], base = 0): LogEntry[] {
  const entries: LogEntry[] = []
  events.forEach((event, index) => {
    const id = `e${base}-${index}`
    if (event.type === 'system' && event.subtype === 'init') {
      entries.push({ id, kind: 'status', text: `会话 ${event.session_id}${event.model ? ' · ' + event.model : ''}` })
    } else if (event.type === 'assistant') {
      for (const [n, part] of (event.message?.content ?? []).entries()) {
        if (part.type === 'text' && part.text) entries.push({ id: `${id}-${n}`, kind: 'message', text: part.text })
        else if (part.type === 'thinking' && part.thinking) entries.push({ id: `${id}-${n}`, kind: 'reasoning', text: part.thinking })
        else if (part.type === 'tool_use' && part.name !== 'StructuredOutput') entries.push(toolEntry(part.id, part.name, part.input))
      }
    } else if (event.type === 'user') {
      for (const part of event.message?.content ?? []) {
        if (part.type !== 'tool_result') continue
        const content = typeof part.content === 'string' ? part.content : (part.content ?? []).map((c: any) => c.text ?? '').join('\n')
        entries.push(finished(part.tool_use_id, content, part.is_error ? 1 : 0))
      }
    } else if (event.type === 'result') {
      const seconds = event.duration_ms ? ` · 用时 ${Math.round(event.duration_ms / 1000)} 秒` : ''
      entries.push(event.is_error
        ? { id, kind: 'error', text: '本轮失败：' + (event.result ?? event.subtype) }
        : { id, kind: 'status', text: `本轮结束${seconds}${event.total_cost_usd != null ? ` · 约 $${Number(event.total_cost_usd).toFixed(2)}` : ''}` })
    }
  })
  return mergeEntries([], entries)
}

// The ZCode runner's log: its own session/result lines around app-server events.
export function zcodeEntries(events: any[], base = 0): LogEntry[] {
  const entries: LogEntry[] = []
  events.forEach((line, index) => {
    const id = `e${base}-${index}`
    if (line.type === 'zcode.session') {
      entries.push({ id, kind: 'status', text: `会话 ${line.sessionId}${line.model?.modelId ? ' · ' + line.model.modelId : ''}` })
      return
    }
    if (line.type === 'zcode.result') {
      if (line.status !== 'completed') entries.push({ id, kind: line.status === 'failed' ? 'error' : 'status', text: (line.status === 'failed' ? '本轮失败：' : '已停止：') + (line.error ?? '') })
      return
    }
    const event = line.event ?? {}
    const payload = event.payload ?? {}
    switch (event.type) {
      case 'turn.started':
        entries.push({ id, kind: 'status', text: '开始执行' })
        return
      case 'turn.completed': {
        const usage = payload.usage ?? {}
        entries.push({ id, kind: 'status', text: `本轮结束 · 输入 ${usage.inputTokens ?? '?'} tokens，输出 ${usage.outputTokens ?? '?'} tokens` })
        return
      }
      case 'turn.failed':
        entries.push({ id, kind: 'error', text: '本轮失败：' + (payload.error?.message ?? payload.resultType ?? '') })
        return
      case 'model.streaming': {
        if (payload.kind === 'tool_call') entries.push(toolEntry(payload.toolCallId, payload.toolName, payload.input))
        else if (payload.kind === 'reasoning_delta' || payload.kind === 'text_delta') {
          const kind = payload.kind === 'text_delta' ? 'message' : 'reasoning'
          entries.push({ id: `${payload.assistantMessageId}-${kind}`, kind, text: payload.delta ?? '', merge: 'append' })
        }
        return
      }
      case 'tool.updated': {
        if (payload.kind !== 'result') return
        const result = payload.result ?? {}
        const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? '')
        entries.push(finished(payload.toolCallId, content, result.perf?.detail?.command?.exitCode ?? (result.success === false ? 1 : 0)))
        return
      }
    }
  })
  return mergeEntries([], entries)
}

export function entriesFor(executor: ExecutorName, events: any[], base = 0): LogEntry[] {
  if (executor === 'claude') return claudeEntries(events, base)
  if (executor === 'zcode') return zcodeEntries(events, base)
  return codexEntries(events, base)
}
