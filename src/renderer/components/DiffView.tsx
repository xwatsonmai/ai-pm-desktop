import { useEffect, useState } from 'react'
import type { DiffView as Diff } from '../../shared/api.js'
import { api } from '../api.js'
import { shortSha } from '../model.js'

function lineClass(line: string) {
  if (line.startsWith('diff --git')) return 'diff-file'
  if (/^(index |new file|deleted file|similarity|rename |--- |\+\+\+ )/.test(line)) return 'diff-meta'
  if (line.startsWith('@@')) return 'diff-hunk'
  if (line.startsWith('+') && !line.startsWith('+++')) return 'diff-add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'diff-del'
  return ''
}

export function DiffView({ taskKey, refresh }: { taskKey: string; refresh: string }) {
  const [diff, setDiff] = useState<Diff | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    api.diff(taskKey).then((d) => live && setDiff(d)).catch(() => live && setDiff(null))
    return () => {
      live = false
    }
  }, [taskKey, refresh])
  if (diff === undefined) return <p className="hint">读取改动…</p>
  if (!diff) return <p className="hint">还没有工作区或提交。</p>
  if (diff.base === diff.head) return <p className="hint">相对起始分支还没有改动。</p>
  return (
    <div className="diff">
      <div className="hint">对比 {shortSha(diff.base)}…{shortSha(diff.head)}</div>
      <pre className="diff-stat">{diff.stat}</pre>
      <pre className="diff-patch">
        {diff.patch.split('\n').map((line, i) => <div key={i} className={lineClass(line)}>{line || ' '}</div>)}
      </pre>
      {diff.truncated && <p className="hint">改动太大，只显示了前一部分。可以在工作区里用 git 查看完整内容。</p>}
    </div>
  )
}
