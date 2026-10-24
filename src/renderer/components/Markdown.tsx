import type { ReactNode } from 'react'

// Requirement text from the platform: headings, lists, emphasis, code and
// links. It is turned into elements, never inserted as HTML, so nothing in a
// requirement can run in the window.
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const key = blocks.length
    if (!line.trim()) {
      i++
      continue
    }
    if (line.startsWith('```')) {
      const body: string[] = []
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i])
      i++
      blocks.push(<pre key={key} className="md-code">{body.join('\n')}</pre>)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6)
      const Tag = `h${level}` as 'h2'
      blocks.push(<Tag key={key} className="md-heading">{inline(heading[2])}</Tag>)
      i++
      continue
    }
    const ordered = /^\s*\d+[.)]\s+/.test(line)
    if (ordered || /^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      const item = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/
      for (; i < lines.length && item.test(lines[i]); i++) items.push(item.exec(lines[i])![1])
      const List = ordered ? 'ol' : 'ul'
      blocks.push(<List key={key} className="md-list">{items.map((t, n) => <li key={n}>{inline(t)}</li>)}</List>)
      continue
    }
    const paragraph: string[] = []
    for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*([-*+]|\d+[.)])\s)/.test(lines[i]); i++) paragraph.push(lines[i].trim())
    blocks.push(<p key={key} className="md-paragraph">{paragraph.flatMap((t, n) => (n ? [<br key={'b' + n} />, inline(t)] : [inline(t)]))}</p>)
  }
  return <div className="markdown">{blocks}</div>
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const key = out.length
    if (match[1]) out.push(<strong key={key}>{match[1]}</strong>)
    else if (match[2]) out.push(<code key={key}>{match[2]}</code>)
    else out.push(<a key={key} href={match[4]} target="_blank" rel="noreferrer">{match[3]}</a>)
    last = match.index + match[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
