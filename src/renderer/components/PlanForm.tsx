import type { PlanQuestion, PlanView } from '../../shared/api.js'
import type { Answers } from '../model.js'
import { Badge, Collapsible } from './ui.js'

function Question({ question, value, onChange }: { question: PlanQuestion; value: string | string[] | undefined; onChange: (v: string | string[]) => void }) {
  const recommended = new Set(question.recommended_option_ids)
  return (
    <div className="question" role="group" aria-label={question.title}>
      <div className="question-title">
        {question.title}
        {question.required ? <span className="required">必填</span> : <span className="optional">选填</span>}
      </div>
      {question.description && <p className="hint">{question.description}</p>}
      {question.kind === 'text' ? (
        <textarea rows={2} value={(value as string) ?? ''} placeholder="填写你的要求" onChange={(e) => onChange(e.target.value)} />
      ) : (
        <div className="options">
          {question.options.map((option) => {
            const multiple = question.kind === 'multiple_choice'
            const selected = multiple ? ((value as string[]) ?? []).includes(option.id) : value === option.id
            return (
              <label key={option.id} className={'option' + (selected ? ' option-selected' : '')}>
                <input
                  type={multiple ? 'checkbox' : 'radio'}
                  name={question.id}
                  checked={selected}
                  onChange={() => {
                    if (!multiple) return onChange(option.id)
                    const current = (value as string[]) ?? []
                    onChange(selected ? current.filter((id) => id !== option.id) : [...current, option.id])
                  }}
                />
                <span className="option-text">
                  <span className="option-label">
                    {option.label}
                    {recommended.has(option.id) && <Badge tone="accent">推荐</Badge>}
                  </span>
                  {option.impact && <span className="hint">{option.impact}</span>}
                </span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function BusinessForm({ plan, answers, onChange }: { plan: PlanView; answers: Answers; onChange: (a: Answers) => void }) {
  if (!plan.business_questions?.length) return <p className="hint">这个方案没有需要你决定的业务问题。</p>
  return (
    <div className="business-form">
      {plan.business_questions.map((q) => (
        <Question key={q.id} question={q} value={answers[q.id]} onChange={(v) => onChange({ ...answers, [q.id]: v })} />
      ))}
    </div>
  )
}

export function PlanBody({ plan, open = false }: { plan: PlanView; open?: boolean }) {
  return (
    <div className="plan-body">
      <Collapsible title="实现步骤" open={open}><pre className="prose">{plan.plan}</pre></Collapsible>
      <Collapsible title="测试与验收" open={open}><pre className="prose">{plan.tests}</pre></Collapsible>
      {plan.risks && <Collapsible title="风险" open={open}><pre className="prose">{plan.risks}</pre></Collapsible>}
      {plan.technical_findings?.length > 0 && (
        <Collapsible title={`技术结论 · ${plan.technical_findings.length}`} open={open}>
          <ul className="findings">
            {plan.technical_findings.map((f, i) => (
              <li key={i}>
                <strong>{f.topic}</strong>：{f.conclusion}
                {f.evidence && <div className="hint">依据：<code>{f.evidence}</code></div>}
              </li>
            ))}
          </ul>
        </Collapsible>
      )}
    </div>
  )
}

export function AnswerList({ plan, answers }: { plan: PlanView; answers: Answers }) {
  const questions = plan.business_questions ?? []
  if (!questions.length) return null
  return (
    <ul className="answers">
      {questions.map((q) => {
        const value = answers[q.id]
        const labels = (Array.isArray(value) ? value : [value]).filter(Boolean).map((id) => q.options.find((o) => o.id === id)?.label ?? id)
        return <li key={q.id}><span className="hint">{q.title}</span><br />{labels.join('、') || '（未回答）'}</li>
      })}
    </ul>
  )
}
