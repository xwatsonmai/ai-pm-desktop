// What the platform accepts on the wire, kept apart from the transport.

// Every top-level tool argument is a string. Structured values travel as JSON
// text; absent values are left out rather than sent as "null".
export function wireArgs(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    out[key] = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
  return out
}

export interface AgentQuestion {
  title: string
  detail: string
}

const MAX_QUESTIONS = 8

// Agents ask open questions. The platform shows each one as a free-text field
// the product owner may skip; questions past its limit go into the body.
export function alignmentRequest(body: string, asked: AgentQuestion[] = []) {
  const usable = asked.filter((q) => q.title.trim())
  const questions = usable.slice(0, MAX_QUESTIONS).map((q, i) => ({
    id: 'q' + (i + 1), label: q.title.trim(), type: 'textarea', options: [], recommended: [], reason: q.detail.trim(), required: false,
  }))
  const overflow = usable.slice(MAX_QUESTIONS).map((q) => `- ${q.title.trim()}${q.detail.trim() ? '：' + q.detail.trim() : ''}`)
  return {
    body: overflow.length ? `${body}\n\n其他问题：\n${overflow.join('\n')}` : body,
    questions: questions.length ? questions : undefined,
  }
}
