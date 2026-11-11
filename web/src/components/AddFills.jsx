import { useState, useMemo } from 'react'
import { T, getZone, zoneLabel } from '../theme'
import { Card, SectionTitle, Btn, Alert } from './UI'
import { importFills } from '../db'
import { parseFills } from '../fillsParser'

// Paste the platform's trade table (or one fill per line) and store it.
export default function AddFills({ onDone, onClose }) {
  const [text, setText] = useState('')
  const [zone, setZone] = useState('local')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const parsed = useMemo(() => parseFills(text), [text])

  const send = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await importFills({
        account: parsed.account || undefined, raw_log: text, fills: parsed.fills,
        time_zone: zone === 'ET' ? 'America/New_York' : getZone(),
      })
      const warn = (r.warnings || []).filter((w) => !/no "date" sent/.test(w))
      setText('')
      onDone(`${r.counts.fills} fills stored.${warn.length ? ` ${warn.join(' ')}` : ''}`)
    } catch (e) { setMsg(e.message) }
    setBusy(false)
  }

  const read = text.trim()
    ? `${parsed.fills.length} fills read${parsed.firstDate ? `, starting ${parsed.firstDate}` : ''}${parsed.skipped.length ? `; ${parsed.skipped.length} ${parsed.skipped.length === 1 ? 'line' : 'lines'} not understood` : ''}`
    : ''

  return (
    <Card style={{ padding: 18 }}>
      <SectionTitle>Add fills</SectionTitle>
      <div style={{ color: T.sub, fontSize: 13, lineHeight: 1.6, marginBottom: 10 }}>
        Paste the trades table from the platform, or one fill per line as time, side, quantity, price. Any day works, including one from earlier in the week. Sending a day again replaces what was stored for it.
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={7} autoFocus
        placeholder="MNQZ6  ACCOUNT  2  27775.75  11/10/2026 8:18:59 PM  1min 12sec  11/10/2026 8:20:11 PM  27821.75  $184.00"
        style={{ width: '100%', background: T.card2, color: T.text, border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 12px', fontFamily: T.mono, lineHeight: 1.5, resize: 'vertical' }} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 10 }}>
        <label style={{ fontSize: 13, color: T.sub }}>Times are in{' '}
          <select value={zone} onChange={(e) => setZone(e.target.value)} style={{ background: T.card2, color: T.text, border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 8px', fontFamily: T.sans }}>
            <option value="local">My time zone ({zoneLabel()})</option>
            <option value="ET">New York (ET)</option>
          </select>
        </label>
        <span style={{ fontSize: 13, color: parsed.fills.length ? T.text : T.muted, flex: 1, minWidth: 140 }}>{read}</span>
        <Btn small onClick={onClose} disabled={busy}>Close</Btn>
        <Btn small accent onClick={send} disabled={busy || !parsed.fills.length}>{busy ? 'Storing' : 'Store'}</Btn>
      </div>
      {parsed.skipped.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: T.muted, fontFamily: T.mono, whiteSpace: 'pre-wrap' }}>{parsed.skipped.slice(0, 4).join('\n')}</div>
      )}
      {msg && <div style={{ marginTop: 10 }}><Alert type="danger">{msg}</Alert></div>}
    </Card>
  )
}
