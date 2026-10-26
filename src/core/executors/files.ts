import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'

// The start or the end of a file, at most `size` bytes.
export function readChunk(path: string, fromEnd: boolean, size: number): string {
  if (!existsSync(path)) return ''
  const fd = openSync(path, 'r')
  try {
    const length = fstatSync(fd).size
    const start = fromEnd ? Math.max(0, length - size) : 0
    const buffer = Buffer.alloc(Math.min(size, length - start))
    readSync(fd, buffer, 0, buffer.length, start)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

// JSON lines of an event log; skips anything else.
export function streamEvents(text: string): any[] {
  return text.split('\n').flatMap((line) => {
    if (!line.startsWith('{')) return []
    try {
      return [JSON.parse(line)]
    } catch {
      return [] // A cut-off first line of a tail read.
    }
  })
}
