import type { LogEntry } from '../shared/api.js'

const clip = (text: string, max = 6_000) => (text.length > max ? text.slice(0, max) + `\n…（还有 ${text.length - max} 个字符）` : text)

// Turns `codex exec --json` events into readable log entries. Unknown shapes are
// shown as compact JSON rather than dropped.
export function codexEntries(events: any[]): LogEntry[] {
  const entries: LogEntry[] = []
  events.forEach((event, index) => {
    const id = event.item?.id ?? `event-${index}`
    switch (event.type) {
      case 'thread.started':
        entries.push({ id, kind: 'status', text: '会话 ' + event.thread_id })
        return
      case 'turn.started':
        entries.push({ id, kind: 'status', text: '开始执行' })
        return
      case 'turn.completed': {
        const usage = event.usage ?? {}
        entries.push({ id, kind: 'status', text: `本轮结束 · 输入 ${usage.input_tokens ?? '?'} tokens，输出 ${usage.output_tokens ?? '?'} tokens` })
        return
      }
      case 'turn.failed':
        entries.push({ id, kind: 'error', text: '本轮失败：' + (event.error?.message ?? JSON.stringify(event.error)) })
        return
      case 'error':
        entries.push({ id, kind: 'error', text: event.message ?? JSON.stringify(event) })
        return
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = event.item ?? {}
        const done = event.type === 'item.completed'
        switch (item.type) {
          case 'agent_message':
            if (done) entries.push({ id, kind: 'message', text: item.text ?? '' })
            return
          case 'reasoning':
            if (done && item.text) entries.push({ id, kind: 'reasoning', text: item.text })
            return
          case 'command_execution':
            entries.push({
              id, kind: 'command', text: item.command ?? '', output: item.aggregated_output ? clip(item.aggregated_output) : undefined,
              exitCode: item.exit_code ?? null, running: !done,
            })
            return
          case 'file_change':
            if (done) entries.push({ id, kind: 'files', text: (item.changes ?? []).map((c: any) => `${c.kind ?? '修改'} ${c.path}`).join('\n') })
            return
          case 'error':
            entries.push({ id, kind: 'error', text: item.message ?? JSON.stringify(item) })
            return
          default:
            if (done) entries.push({ id, kind: 'other', text: clip(`${item.type}: ${JSON.stringify(item)}`, 1_000) })
        }
        return
      }
      default:
        entries.push({ id, kind: 'other', text: clip(JSON.stringify(event), 1_000) })
    }
  })
  // A later entry with the same id (a completed command) replaces the earlier one.
  const byId = new Map<string, LogEntry>()
  for (const entry of entries) byId.set(entry.id, entry)
  return entries.filter((entry) => byId.get(entry.id) === entry)
}
