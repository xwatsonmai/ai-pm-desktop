import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { RunView } from '../src/shared/api.js'
import { RunMessageForm } from '../src/renderer/components/LogView.js'
import { entriesFor, zcodeEntries } from '../src/main/agent-log.js'
import { mergeEntries } from '../src/shared/log.js'

it('offers a plain conversation input only on a message-capable live run', () => {
  const run = { id: 'run', taskKey: 'batch:test', executor: 'zcode', endedAt: null, canMessage: true } as RunView
  const html = renderToStaticMarkup(<RunMessageForm run={run} />)
  expect(html).toContain('补充指令')
  expect(html).toContain('发送')
  expect(html).not.toMatch(/已接收|等待处理|已送入/)
  expect(renderToStaticMarkup(<RunMessageForm run={{ ...run, endedAt: 'done' }} />)).toBe('')
  expect(renderToStaticMarkup(<RunMessageForm run={{ ...run, canMessage: false }} />)).toBe('')
})

it('keeps user text as literal conversation content and deduplicates its log ID', () => {
  const event = { type: 'zcode.user', id: 'one', text: '<script>not markup</script>' }
  const first = zcodeEntries([event], 0), second = zcodeEntries([event], 100)
  expect(mergeEntries(first, second)).toEqual([{ id: 'user-one', kind: 'user', text: event.text }])
  for (const executor of ['codex', 'claude'] as const) {
    const entry = { ...event, type: 'run.user' }
    expect(mergeEntries(entriesFor(executor, [entry]), entriesFor(executor, [entry], 100)))
      .toEqual([{ id: 'user-one', kind: 'user', text: event.text }])
  }
})
