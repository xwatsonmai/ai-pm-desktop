import { describe, expect, it } from 'vitest'
import { claudeEntries, zcodeEntries } from '../src/main/agent-log.js'
import { mergeEntries } from '../src/shared/log.js'

const view = (entries: ReturnType<typeof claudeEntries>) => entries.map(({ merge, ...e }) => e)

describe('Claude Code log', () => {
  const events = [
    { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus' },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '先看日志' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git log -1' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'abc init', is_error: false }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'src/a.ts' } }, { type: 'tool_use', id: 't3', name: 'StructuredOutput', input: {} }] } },
    { type: 'result', subtype: 'success', is_error: false, duration_ms: 4200, total_cost_usd: 0.071 },
  ]

  it('shows commands with their output, edits, thinking and the result', () => {
    expect(view(claudeEntries(events))).toEqual([
      { id: 'e0-0', kind: 'status', text: '会话 s1 · claude-opus' },
      { id: 'e0-1-0', kind: 'reasoning', text: '先看日志' },
      { id: 't1', kind: 'command', text: 'git log -1', running: false, output: 'abc init', exitCode: 0 },
      { id: 't2', kind: 'files', text: '修改 src/a.ts' },
      { id: 'e0-4', kind: 'status', text: '本轮结束 · 用时 4 秒 · 约 $0.07' },
    ])
  })

  it('fills in a command whose result arrives in a later chunk', () => {
    const first = claudeEntries(events.slice(0, 2), 0)
    const second = claudeEntries(events.slice(2), 500)
    const log = mergeEntries(mergeEntries([], first), second)
    expect(view(log).find((e) => e.id === 't1')).toEqual({ id: 't1', kind: 'command', text: 'git log -1', running: false, output: 'abc init', exitCode: 0 })
    expect(new Set(log.map((e) => e.id)).size).toBe(log.length)
  })
})

describe('ZCode log', () => {
  const event = (type: string, payload: object) => ({ type: 'zcode.event', event: { type, turnId: 'turn_1', payload } })
  const lines = [
    { type: 'zcode.session', sessionId: 'sess_1', model: { modelId: 'glm-5' } },
    event('turn.started', { inputId: 'i1' }),
    event('model.streaming', { assistantMessageId: 'm1', kind: 'reasoning_delta', delta: '先' }),
    event('model.streaming', { assistantMessageId: 'm1', kind: 'reasoning_delta', delta: '看看' }),
    event('model.streaming', { assistantMessageId: 'm1', kind: 'tool_call', toolCallId: 'c1', toolName: 'Bash', input: { command: 'ls' } }),
    event('tool.updated', { kind: 'result', toolCallId: 'c1', result: { success: true, content: 'a.txt', perf: { detail: { command: { exitCode: 0 } } } } }),
    event('model.streaming', { assistantMessageId: 'm2', kind: 'text_delta', delta: '{"files":' }),
    event('model.streaming', { assistantMessageId: 'm2', kind: 'text_delta', delta: ' 1}' }),
    event('turn.completed', { inputId: 'i1', resultType: 'success', usage: { inputTokens: 10, outputTokens: 2 } }),
    { type: 'zcode.result', status: 'completed' },
  ]

  it('joins streamed text and shows tool calls with their output', () => {
    expect(view(zcodeEntries(lines))).toEqual([
      { id: 'e0-0', kind: 'status', text: '会话 sess_1 · glm-5' },
      { id: 'e0-1', kind: 'status', text: '开始执行' },
      { id: 'm1-reasoning', kind: 'reasoning', text: '先看看' },
      { id: 'c1', kind: 'command', text: 'ls', running: false, output: 'a.txt', exitCode: 0 },
      { id: 'm2-message', kind: 'message', text: '{"files": 1}' },
      { id: 'e0-8', kind: 'status', text: '本轮结束 · 输入 10 tokens，输出 2 tokens' },
    ])
  })

  it('keeps streamed text and tool output whole across chunks', () => {
    const chunks = [lines.slice(0, 3), lines.slice(3, 5), lines.slice(5, 7), lines.slice(7)]
    let log = mergeEntries([], [])
    chunks.forEach((chunk, n) => (log = mergeEntries(log, zcodeEntries(chunk, n * 100))))
    expect(view(log)).toEqual(view(zcodeEntries(lines)).map((e) => (e.id === 'e0-8' ? { ...e, id: 'e300-1' } : e)))
  })

  it('reports a failed or stopped turn', () => {
    expect(view(zcodeEntries([{ type: 'zcode.result', status: 'failed', error: 'quota' }]))).toEqual([{ id: 'e0-0', kind: 'error', text: '本轮失败：quota' }])
  })
})
