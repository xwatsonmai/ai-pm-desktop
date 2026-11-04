import type { RequirementView } from '../../shared/api.js'
import { Markdown } from './Markdown.js'
import { Collapsible } from './ui.js'

export function Requirement({ requirement }: { requirement: RequirementView | null }) {
  if (!requirement) return <p className="hint">还没有从平台读到需求内容。</p>
  const { description, acceptance, decisions, original, parent, revision, localApproval } = requirement
  return (
    <div className="panel requirement">
      {revision != null && <p className="hint">平台需求 · 修订 R{revision}</p>}
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
      {localApproval && <section className="scope-record">
        <h3>本地已确认方案{localApproval.revision != null ? ` · R${localApproval.revision}` : ''}</h3>
        <p className="hint">本地方案确认不会修改平台需求正文。请对照上方需求及验收条件；口径不一致时，应先在平台确认需求范围，再修订方案。</p>
        {revision != null && localApproval.revision !== revision && <p className="hint">此方案基于其他修订，不能作为当前需求已确认的依据。</p>}
        <Markdown text={[localApproval.summary, localApproval.plan].filter(Boolean).join('\n\n')} />
      </section>}
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
