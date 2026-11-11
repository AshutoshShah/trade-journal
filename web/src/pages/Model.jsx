import { useState, useEffect } from 'react'
import { T } from '../theme'
import { Card, Btn, Alert } from '../components/UI'
import { getProfile, updateProfile } from '../db'
import { useMobile } from '../hooks/useMobile'

// How I trade: a short description in plain words, not a checklist. Every
// section is free text and can be rewritten, added or removed. Stored on the
// profile as `model`.

// A starting point to write over. Nothing here is a rule the journal enforces.
const DRAFT = {
  sections: [
    {
      title: 'The idea',
      body: 'What you trade, at what time of day, and the kind of move you are looking for. Write it the way you would explain it to another trader. Press Edit to replace this text.',
    },
    {
      title: 'What I mark',
      body: 'The levels or context you prepare before the session, and anything you add while it runs.',
    },
    {
      title: 'Getting in and out',
      body: 'How you enter and exit: all at once or in pieces, where you get out when you are wrong, and how you take profit.',
    },
    {
      title: 'What I watch in myself',
      body: 'The habits that cost you when they show up, such as trading too often, sizing up after a loss, or holding a loser.',
    },
  ],
  limits: { risk: '', dayStop: '', maxPositions: '', size: '' },
}

const LIMITS = [
  { key: 'risk', label: 'Risk per position' },
  { key: 'dayStop', label: 'Daily stop' },
  { key: 'maxPositions', label: 'Positions per day' },
  { key: 'size', label: 'Usual size (contracts)' },
]

function Body({ text }) {
  const blocks = String(text || '').split(/\n\s*\n/).filter((b) => b.trim())
  return blocks.map((b, i) => {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.every((l) => /^[-•]\s+/.test(l))) {
      return (
        <ul key={i} style={{ margin: '0 0 12px', paddingLeft: 20, color: T.text, fontSize: 15, lineHeight: 1.7 }}>
          {lines.map((l, j) => <li key={j}>{l.replace(/^[-•]\s+/, '')}</li>)}
        </ul>
      )
    }
    return <p key={i} style={{ margin: '0 0 12px', color: T.text, fontSize: 15, lineHeight: 1.7 }}>{lines.join(' ')}</p>
  })
}

const field = {
  width: '100%', background: T.card2, color: T.text, border: `1px solid ${T.border}`, borderRadius: 7,
  padding: '9px 11px', fontFamily: T.sans, lineHeight: 1.6,
}

export default function Model() {
  const mobile = useMobile()
  const [model, setModel] = useState(null)
  const [saved, setSaved] = useState(true)
  const [isDraft, setIsDraft] = useState(false)
  const [edit, setEdit] = useState(false)
  const [work, setWork] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    getProfile().then((p) => {
      const m = p && p.model
      if (m && Array.isArray(m.sections)) { setModel({ ...DRAFT, ...m, limits: { ...DRAFT.limits, ...(m.limits || {}) } }) }
      else { setModel(DRAFT); setIsDraft(true); setSaved(false) }
    }).catch((e) => setErr(e.message))
  }, [])

  const start = () => { setWork(JSON.parse(JSON.stringify(model))); setEdit(true) }
  const cancel = () => { setEdit(false); setWork(null) }
  const save = async (m) => {
    setBusy(true); setErr(null)
    try {
      const next = { sections: m.sections.filter((s) => s.title.trim() || s.body.trim()), limits: m.limits, updatedAt: new Date().toISOString() }
      await updateProfile({ model: next })
      setModel(next); setSaved(true); setIsDraft(false); setEdit(false); setWork(null)
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }
  const setSection = (i, patch) => setWork((w) => ({ ...w, sections: w.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) }))
  const move = (i, d) => setWork((w) => {
    const a = [...w.sections]; const j = i + d
    if (j < 0 || j >= a.length) return w
    ;[a[i], a[j]] = [a[j], a[i]]
    return { ...w, sections: a }
  })

  if (!model) return err ? <Alert type="danger">{err}</Alert> : <div style={{ color: T.muted, padding: 30, textAlign: 'center' }}>Loading</div>

  const m = edit ? work : model
  const anyLimit = LIMITS.some((l) => (model.limits[l.key] || '').trim())

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: mobile ? 22 : 26, fontWeight: 800, color: T.text, letterSpacing: '-0.02em' }}>How I trade</div>
          {model.updatedAt && !edit && (
            <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>
              Last changed {new Date(model.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
            </div>
          )}
        </div>
        {edit ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn small onClick={cancel} disabled={busy}>Cancel</Btn>
            <Btn small accent onClick={() => save(work)} disabled={busy}>{busy ? 'Saving' : 'Save'}</Btn>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            {isDraft && <Btn small accent onClick={() => save(model)} disabled={busy}>Keep as is</Btn>}
            <Btn small onClick={start}>Edit</Btn>
          </div>
        )}
      </div>

      {err && <Alert type="danger">{err}</Alert>}
      {isDraft && !edit && (
        <Alert type="info">A first draft, written from how you described your trading. Change anything that is not in your words, then save it.</Alert>
      )}

      {m.sections.map((s, i) => (
        <Card key={i} style={{ padding: mobile ? 16 : 22 }}>
          {edit ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={s.title} onChange={(e) => setSection(i, { title: e.target.value })} placeholder="Heading" style={{ ...field, fontWeight: 700 }} />
                <Btn small onClick={() => move(i, -1)} disabled={i === 0}>Up</Btn>
                <Btn small onClick={() => move(i, 1)} disabled={i === m.sections.length - 1}>Down</Btn>
                <Btn small onClick={() => setWork((w) => ({ ...w, sections: w.sections.filter((_, j) => j !== i) }))}>Remove</Btn>
              </div>
              <textarea value={s.body} onChange={(e) => setSection(i, { body: e.target.value })} rows={Math.max(4, s.body.split('\n').length + 1)}
                placeholder="Write it the way you would say it. Start a line with a dash to make a list." style={{ ...field, resize: 'vertical' }} />
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', color: T.accent, marginBottom: 12 }}>{s.title}</div>
              <Body text={s.body} />
            </>
          )}
        </Card>
      ))}

      {edit && (
        <div>
          <Btn small onClick={() => setWork((w) => ({ ...w, sections: [...w.sections, { title: '', body: '' }] }))}>Add a section</Btn>
        </div>
      )}

      {(edit || anyLimit) && (
        <Card style={{ padding: mobile ? 16 : 22 }}>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', color: T.accent, marginBottom: 6 }}>Fixed, outside the chart</div>
          <div style={{ fontSize: 13, color: T.muted, marginBottom: 14, lineHeight: 1.6 }}>
            The only numbers on this page, and the ones Sessions uses for its flags. Leave any of them empty.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: mobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
            {LIMITS.map((l) => (
              <div key={l.key}>
                <div style={{ fontSize: 10, letterSpacing: '.07em', textTransform: 'uppercase', color: T.muted, marginBottom: 6 }}>{l.label}</div>
                {edit ? (
                  <input value={work.limits[l.key] || ''} onChange={(e) => setWork((w) => ({ ...w, limits: { ...w.limits, [l.key]: e.target.value } }))}
                    placeholder="Not set" style={field} />
                ) : (
                  <div style={{ fontFamily: T.mono, fontSize: 17, color: (model.limits[l.key] || '').trim() ? T.text : T.muted }}>
                    {(model.limits[l.key] || '').trim() || 'Not set'}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {!edit && !saved && !isDraft && <div style={{ color: T.muted, fontSize: 12 }}>Not saved yet.</div>}
    </div>
  )
}
