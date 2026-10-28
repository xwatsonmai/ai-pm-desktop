import { Check, CircleAlert } from 'lucide-react'
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import type { Result } from '../../shared/api.js'
import type { Tone } from '../model.js'

export function Badge({ tone = 'muted', dot, live, children }: { tone?: Tone; dot?: boolean; live?: boolean; children: ReactNode }) {
  return (
    <span className={'badge badge-' + tone}>
      {(dot || live) && <span className={'dot' + (live ? ' dot-live' : '')} />}
      {children}
    </span>
  )
}

export function Button(props: {
  children: ReactNode
  onClick?: () => void | Promise<unknown>
  kind?: 'primary' | 'accent' | 'secondary' | 'danger' | 'ghost'
  icon?: ReactNode
  disabled?: boolean
  title?: string
  small?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const click = async () => {
    if (!props.onClick || busy) return
    setBusy(true)
    try {
      await props.onClick()
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      className={`btn btn-${props.kind ?? 'secondary'}${props.small ? ' btn-small' : ''}`}
      disabled={props.disabled || busy}
      title={props.title}
      onClick={click}
    >
      {busy ? <span className="spinner" /> : props.icon}
      {props.children}
    </button>
  )
}

// A button that opens a text box, for actions that need a note or a reason.
export function TextAction(props: {
  label: string
  icon?: ReactNode
  submitLabel?: string
  placeholder?: string
  required?: boolean
  kind?: 'primary' | 'accent' | 'secondary' | 'danger' | 'ghost'
  onSubmit: (text: string) => Promise<boolean | void>
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  if (!open) return <Button kind={props.kind ?? 'secondary'} icon={props.icon} onClick={() => setOpen(true)}>{props.label}</Button>
  return (
    <div className="text-action">
      <textarea autoFocus value={text} placeholder={props.placeholder} onChange={(e) => setText(e.target.value)} rows={3} />
      <div className="row">
        <Button
          kind={props.kind === 'danger' ? 'danger' : 'primary'}
          disabled={props.required && !text.trim()}
          onClick={async () => {
            const done = await props.onSubmit(text.trim())
            if (done !== false) {
              setOpen(false)
              setText('')
            }
          }}
        >
          {props.submitLabel ?? '提交'}
        </Button>
        <Button kind="ghost" onClick={() => setOpen(false)}>取消</Button>
      </div>
    </div>
  )
}

export function PageHeader({ title, subtitle, aside }: { title: string; subtitle?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle && <div className="page-subtitle">{subtitle}</div>}
      </div>
      {aside}
    </header>
  )
}

export function Section({ title, count, children, aside, description }: { title: string; count?: number; children: ReactNode; aside?: ReactNode; description?: string }) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        {count !== undefined && <span className="count">{count}</span>}
        {aside && <div className="aside">{aside}</div>}
      </div>
      {description && <p className="section-desc">{description}</p>}
      {children}
    </section>
  )
}

export function Empty({ title, icon, children }: { title: string; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  )
}

export function Collapsible({ title, children, open = false }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="collapsible" open={open}>
      <summary>{title}</summary>
      <div className="collapsible-body">{children}</div>
    </details>
  )
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return <button className={'toggle' + (on ? ' on' : '')} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />
}

// ---- toasts ----

interface Toast {
  id: number
  text: string
  tone: 'ok' | 'danger'
}

const ToastContext = createContext<(text: string, tone?: 'ok' | 'danger') => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const show = useCallback((text: string, tone: 'ok' | 'danger' = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((list) => [...list, { id, text, tone }])
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), tone === 'danger' ? 7_000 : 3_000)
  }, [])
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={'toast toast-' + t.tone}>
            {t.tone === 'ok' ? <Check size={15} /> : <CircleAlert size={15} />}
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

// Reloads what the window shows; a page with data of its own provides one that reloads that too.
export const RefreshContext = createContext<() => Promise<unknown>>(async () => {})

// Runs a call that returns a Result and reports failures; resolves to whether it worked.
// After a success it waits for the reload, so the button that ran it stays busy until
// the window shows the new state and a second click cannot repeat it on the old one.
export async function runCommand(call: Promise<Result<unknown>>, toast: (text: string, tone?: 'ok' | 'danger') => void, refresh: () => Promise<unknown>, success?: string): Promise<boolean> {
  const result = await call
  if (!result.ok) {
    toast(result.message, 'danger')
    return false
  }
  await refresh().catch(() => {})
  if (success) toast(success)
  return true
}

export function useRun(refresh?: () => Promise<unknown>) {
  const toast = useToast()
  const shown = useContext(RefreshContext)
  const reload = refresh ?? shown
  return useCallback((call: Promise<Result<unknown>>, success?: string) => runCommand(call, toast, reload, success), [toast, reload])
}
