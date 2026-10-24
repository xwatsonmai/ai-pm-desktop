import type { RequirementView } from '../../shared/api.js'
import { Markdown } from './Markdown.js'
import { Collapsible } from './ui.js'

export function Requirement({ requirement }: { requirement: RequirementView | null }) {
  if (!requirement) return <p className="hint">还没有从平台读到需求内容。</p>
  const { description, acceptance, decisions, original, parent, revision } = requirement
  return (
    <div className="panel requirement">
      {revision != null && <p className="hint">平台上的修订 R{revision}。Agent 的方案以这一版为准。</p>}
      {description ? <Markdown text={description} /> : <p className="hint">需求没有正文。</p>}
      {acceptance.length > 0 && (
        <>
          <h3>验收条件</h3>
          <ol className="md-list">{acceptance.map((a, i) => <li key={i}>{a}</li>)}</ol>
        </>
      )}
      {decisions.length > 0 && (
        <>
          <h3>评审中确认的结论</h3>
          <ul className="decisions">
            {decisions.map((d, i) => <li key={i}><strong>{d.title}</strong><div>{d.conclusion}</div></li>)}
          </ul>
        </>
      )}
      {parent && (
        <Collapsible title="所属需求">
          <Markdown text={parent.description} />
          {parent.acceptance.length > 0 && <ol className="md-list">{parent.acceptance.map((a, i) => <li key={i}>{a}</li>)}</ol>}
        </Collapsible>
      )}
      {original && (
        <Collapsible title="产品最初写的原文">
          <Markdown text={original} />
        </Collapsible>
      )}
    </div>
  )
}
