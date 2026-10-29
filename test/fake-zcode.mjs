#!/usr/bin/env node
// Stand-in for the ZCode CLI's `app-server --stdio`, playing the scenarios in
// fake-agent.mjs. New sessions reply in a ```json fence, as chat models often do.
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { play } from './fake-agent.mjs'

const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('0.0.0-fake')
  process.exit(0)
}
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const MODELS = [
  { ref: { providerId: 'prov-a', modelId: 'glm-fake' }, label: 'glm-fake', providerLabel: 'Z.AI', reasoning: { levels: [{ value: 'low' }, { value: 'max' }], defaultLevel: 'max' } },
  { ref: { providerId: 'prov-b', modelId: 'z-ai/other' }, label: 'z-ai/other', providerLabel: '英伟达', reasoning: { levels: [{ value: 'enabled' }], defaultLevel: 'enabled' } },
]
const sessions = new Map()
let seq = 0
let requestId = 1000
let accountSynced = false

function state(session) {
  return {
    session: { sessionId: session.id, workspace: session.workspace, mode: session.mode, model: session.model ?? MODELS[0].ref },
    settings: { mode: { current: session.mode }, model: { current: MODELS[0].ref, available: MODELS } },
    messages: session.messages,
  }
}
function event(session, type, turnId, payload) {
  send({ method: 'session/event', params: { sessionId: session.id, seq: ++seq, type, turnId, payload } })
}
function turn(session, inputId, content, model) {
  const turnId = 'turn_' + randomUUID()
  const action = play({
    executor: 'zcode', prompt: content, cwd: session.workspace.workspacePath, session: session.id, resumed: session.resumed,
    fullAccess: session.mode === 'yolo',
    config: [...(model ? [`model=${model.providerId}::${model.modelId}`, `effort=${model.options?.reasoningLevel ?? ''}`] : []), ...session.deny.map((t) => 'deny=' + t)],
  })
  event(session, 'turn.started', turnId, { inputId })
  const reply = (text) => {
    // New sessions answer in a fence, resumed ones with bare JSON, as models vary.
    const response = session.resumed ? text : '结果如下：\n```json\n' + text + '\n```'
    // Like the real server: messages read back carry no turn id; the turn's reply comes with turn.completed.
    session.messages.push({ info: { role: 'assistant' }, parts: [{ type: 'text', text: response }] })
    event(session, 'turn.completed', turnId, { inputId, resultType: 'success', response })
  }
  if (action.type === 'crash') process.exit(3)
  else if (action.type === 'fail') event(session, 'turn.failed', turnId, { inputId, resultType: 'error', error: { message: action.message } })
  else if (action.type === 'hang') setTimeout(() => reply(action.text()), action.ms)
  else setTimeout(() => reply(action.text), 20)
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method == null) return // our answer to a request we sent
  const { id, method, params } = message
  const reply = (result) => send({ id, result })
  switch (method) {
    case 'provider/updateAccountConfig':
      if (process.env.FAKE_ZCODE_ACCOUNT_REJECT === '1') send({ id, error: { code: -32601, message: 'unsupported account sync' } })
      else { accountSynced = true; reply({ status: 'received', providerCount: Object.keys(params.providers ?? {}).length }) }
      break
    case 'session/create': {
      if (params.model && !params.model.options?.reasoningLevel) { send({ id, error: { code: -32000, message: 'Reasoning level is required' } }); break }
      if (process.env.FAKE_ZCODE_REQUIRE_ACCOUNT === '1' && !accountSynced) { send({ id, error: { code: -32000, message: 'account snapshot required before session/create' } }); break }
      if (process.env.FAKE_ZCODE_CREATE_HANG === '1') break
      const session = { id: 'sess_' + randomUUID(), workspace: params.workspace, mode: params.mode, model: params.model, messages: [], resumed: false, deny: params.toolDenylist ?? [] }
      sessions.set(session.id, session)
      // Like the real server, ask the client for runtime preferences first.
      send({ id: ++requestId, method: 'session/requestRuntimePreferences', params: {} })
      const created = state(session)
      if (process.env.FAKE_ZCODE_EMPTY_MODELS === '1') created.settings.model.available = []
      reply(created)
      break
    }
    case 'session/resume': {
      // A resumed session holds the earlier turns' replies.
      const earlier = { info: { role: 'assistant' }, parts: [{ type: 'text', text: '上一轮的回复 {"status":"done"}' }] }
      const session = { id: params.sessionId, workspace: params.workspace, mode: 'build', messages: [earlier], resumed: true, deny: params.toolDenylist ?? [] }
      sessions.set(session.id, session)
      reply(state(session))
      break
    }
    case 'session/setMode':
      sessions.get(params.sessionId).mode = params.mode
      reply({})
      break
    case 'session/setModel': {
      const offered = MODELS.find(m => m.ref.providerId === params.model.providerId && m.ref.modelId === params.model.modelId)
      if (offered?.reasoning?.levels?.length && !params.model.options?.reasoningLevel) { send({ id, error: { code: -32000, message: 'Reasoning level is required' } }); break }
      sessions.get(params.sessionId).model = params.model
      reply(state(sessions.get(params.sessionId)))
      break
    }
    case 'session/subscribe':
      // Replays an earlier turn's events, which the client must not log as this turn's.
      event(sessions.get(params.sessionId), 'turn.completed', 'turn_old', { inputId: 'old', resultType: 'success' })
      reply({ subscribed: true })
      break
    case 'session/send':
      if (params.modelSelection && !params.modelSelection.options?.reasoningLevel) { send({ id, error: { code: -32000, message: 'Reasoning level is required' } }); break }
      reply({ sessionId: params.sessionId, accepted: true })
      turn(sessions.get(params.sessionId), params.inputId, params.content, params.modelSelection)
      break
    case 'session/read':
      reply(state(sessions.get(params.sessionId)))
      break
    case 'session/stop':
    case 'session/close':
      reply({ closed: true })
      break
    default:
      send({ id, error: { code: -32601, message: 'unknown method ' + method } })
  }
})
