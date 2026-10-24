import AjvModule from 'ajv'
import { schemas, type SchemaName } from './schemas.js'

const Ajv = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule
const ajv = new (Ajv as any)({ allErrors: true, strict: false })
const validators = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]))

// Accepts bare JSON, JSON inside a code fence, or JSON surrounded by prose.
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const candidates = [trimmed]
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/.exec(trimmed)
  if (fence) candidates.push(fence[1].trim())
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

export type Validated = { ok: true; value: any } | { ok: false; error: string }

export function validateResult(name: SchemaName, text: string | undefined): Validated {
  if (!text?.trim()) return { ok: false, error: '没有输出最终结果' }
  const value = extractJson(text)
  if (value === undefined) return { ok: false, error: '最终输出不是 JSON 对象' }
  const validate = validators[name]
  if (!validate(value)) {
    const errors = (validate.errors ?? []).slice(0, 5).map((e: any) => `${e.instancePath || '/'} ${e.message}`)
    return { ok: false, error: '字段不符合要求：' + errors.join('；') }
  }
  return { ok: true, value }
}
