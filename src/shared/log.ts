import type { LogEntry } from './api.js'

// Adds entries to a log in order, combining each with an earlier one of the same
// id as it asks. Used within one chunk of a run log and again across chunks.
export function mergeEntries(log: LogEntry[], add: LogEntry[]): LogEntry[] {
  const merged = [...log]
  const index = new Map(merged.map((e, i) => [e.id, i]))
  for (const { merge, ...entry } of add) {
    const at = index.get(entry.id)
    if (at === undefined) {
      index.set(entry.id, merged.length)
      merged.push({ ...entry, kind: entry.kind ?? 'other', text: entry.text ?? '', ...(merge ? { merge } : {}) })
      continue
    }
    const before = merged[at]
    if (merge === 'append') merged[at] = { ...before, text: before.text + entry.text }
    else if (merge === 'patch') merged[at] = { ...before, ...Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined && v !== '')) }
    else merged[at] = entry
  }
  return merged
}
