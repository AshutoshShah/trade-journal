import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { T, today } from '../theme'
import { Card, Btn, Alert } from '../components/UI'
import AddFills from '../components/AddFills'
import PriceChart from '../components/PriceChart'
import { getSessions, getSessionDay, saveSessionDay, getDailyCharts, uploadChart, deleteChart, chartUrl, getProfile } from '../db'
import { useMobile } from '../hooks/useMobile'
import { money, tone, local, hold, px, shiftDate, dayLabel, recentWeekdays, applyFees, groupDays } from '../lib'

// One trading day on one page: what was marked beforehand, the positions taken
// (read from the fills, nothing to type), the chart, and a few words after.
//
// A session is often written up the next day, when New York has already moved
// to a new date (for traders in Asia, the US session ends after midnight). So
// the page opens on the last day that has fills unless today already has some,
// and any recent day is one tap away.

const label = { fontSize: 12, fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', color: T.accent }
const area = {
  width: '100%', background: T.card2, color: T.text, border: `1px solid ${T.border}`, borderRadius: 8,
  padding: '11px 13px', fontFamily: T.sans, lineHeight: 1.65, resize: 'vertical',
}
const link = { background: 'transparent', border: 'none', color: T.muted, fontSize: 12, cursor: 'pointer', textDecoration: 'underline', fontFamily: T.sans, padding: 0, minHeight: 0 }

export default function Today({ onNavigate, config }) {
  const images = !!(config && config.images)
  const mobile = useMobile()
  const [date, setDate] = useState(null)
  const [recent, setRecent] = useState(null)          // positions for the last two weeks
  const [fees, setFees] = useState({})
  const [day, setDay] = useState({ plan: '', review: '' })
  const [savedDay, setSavedDay] = useState({ plan: '', review: '' })
  const [state, setState] = useState('')
  const [charts, setCharts] = useState([])
  const [adding, setAdding] = useState(false)
  const [notice, setNotice] = useState(null)
  const [err, setErr] = useState(null)
  const fileRef = useRef(null)
  const now = today()

  const loadRecent = useCallback(() => getSessions({ from: shiftDate(today(), -16) })
    .then((d) => { setRecent(d.positions); return d.positions })
    .catch((e) => { setErr(e.message); return [] }), [])

  // First load: pick the day to open on.
  useEffect(() => {
    getProfile().then((p) => setFees((p && p.fees) || {})).catch(() => {})
    loadRecent().then((positions) => {
      const dates = [...new Set(positions.map((p) => p.date))].sort()
      setDate(dates.includes(today()) || !dates.length ? today() : dates[dates.length - 1])
    })
  }, [loadRecent])

  // Fills arrive from outside the page, so the list refreshes on its own.
  useEffect(() => { const i = setInterval(() => { if (!document.hidden) loadRecent() }, 120000); return () => clearInterval(i) }, [loadRecent])

  useEffect(() => {
    if (!date) return
    setErr(null); setState('')
    getSessionDay(date).then((d) => { const v = { plan: d.plan || '', review: d.review || '' }; setDay(v); setSavedDay(v) }).catch((e) => setErr(e.message))
    if (images) getDailyCharts(date).then(setCharts).catch(() => setCharts([]))
  }, [date])

  const days = useMemo(() => groupDays(applyFees(recent || [], fees)), [recent, fees])
  const strip = useMemo(() => {
    const byDate = new Map(days.map((d) => [d.date, d]))
    const list = recentWeekdays(8)
    if (date && !list.includes(date)) list.unshift(date)
    return list.map((d) => ({ date: d, day: byDate.get(d) }))
  }, [days, date])
  const cur = days.find((d) => d.date === date)
  const positions = cur ? cur.list : []
  const closed = cur ? cur.closed : []
  const won = closed.filter((p) => p.pnl > 0).length

  const save = async () => {
    if (day.plan === savedDay.plan && day.review === savedDay.review) return
    setState('Saving')
    try { await saveSessionDay(date, day); setSavedDay(day); setState('Saved') } catch (e) { setState(''); setErr(e.message) }
  }
  const addChart = async (file) => {
    if (!file) return
    try { await uploadChart(date, file); setCharts(await getDailyCharts(date)) } catch (x) { setErr(x.message) }
  }
  const removeChart = async (c) => {
    try { await deleteChart(c.id); setCharts(await getDailyCharts(date)) } catch (x) { setErr(x.message) }
  }

  // A screenshot on the clipboard can be pasted straight onto the page.
  useEffect(() => {
    if (!date || !images) return undefined
    const onPaste = (e) => {
      const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith('image/'))
      if (!item) return
      e.preventDefault()
      addChart(item.getAsFile())
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [date]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!date) return err ? <Alert type="danger">{err}</Alert> : <div style={{ color: T.muted, padding: 30, textAlign: 'center' }}>Loading</div>

  const isToday = date === now
  const sub = isToday ? 'Today' : date === shiftDate(now, -1) ? 'Yesterday' : 'An earlier day'

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }}>
      <div className="scroll-x">
        <div style={{ display: 'flex', gap: 6, minWidth: 'min-content' }}>
          {strip.map(({ date: d, day: x }) => {
            const active = d === date
            return (
              <button key={d} onClick={() => setDate(d)} style={{
                flex: '1 0 86px', background: active ? `${T.accent}14` : T.card, border: `1px solid ${active ? T.accent : T.border}`, borderRadius: 9,
                padding: '8px 6px', cursor: 'pointer', fontFamily: T.sans, textAlign: 'center',
              }}>
                <div style={{ fontSize: 11, color: active ? T.accent : T.muted, fontWeight: 600 }}>
                  {d === now ? 'Today' : dayLabel(d, { weekday: 'short', day: 'numeric', month: 'short' })}
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, marginTop: 3, color: x && x.closed.length ? tone(x.net) : T.label }}>
                  {x && x.closed.length ? money(x.net) : 'no fills'}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: mobile ? 22 : 26, fontWeight: 800, color: T.text, letterSpacing: '-0.02em' }}>{dayLabel(date, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>{sub}{state ? ` · ${state}` : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" value={date} max={now} onChange={(e) => e.target.value && setDate(e.target.value)}
            style={{ background: T.card2, color: T.text, border: `1px solid ${T.border}`, borderRadius: 7, padding: '7px 8px', fontFamily: T.sans, colorScheme: 'dark' }} />
          <Btn small accent onClick={() => setAdding((v) => !v)}>Add fills</Btn>
        </div>
      </div>

      {adding && <AddFills onClose={() => setAdding(false)} onDone={(m) => {
        setNotice(m); setAdding(false)
        loadRecent().then((ps) => { const ds = [...new Set(ps.map((p) => p.date))].sort(); if (ds.length && !ds.includes(date)) setDate(ds[ds.length - 1]) })
      }} />}
      {notice && <Alert type="ok">{notice}</Alert>}
      {err && <Alert type="danger">{err}</Alert>}

      <Card style={{ padding: 18 }}>
        <div style={{ ...label, marginBottom: 12 }}>Before</div>
        <textarea value={day.plan} onChange={(e) => setDay((d) => ({ ...d, plan: e.target.value }))} onBlur={save} rows={mobile ? 4 : 5}
          placeholder="Levels marked, anything worth remembering going in." style={area} />
      </Card>

      <Card style={{ padding: mobile ? '16px 12px' : 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 12, padding: mobile ? '0 4px' : 0 }}>
          <div style={label}>Positions</div>
          {closed.length > 0 && (
            <div style={{ display: 'flex', gap: 14, alignItems: 'baseline' }}>
              <span style={{ fontSize: 12, color: T.muted }}>
                {closed.length} taken, {won} won{cur.gaveBack > 0 && cur.peak > 0 ? `, high of the day ${money(cur.peak)}` : ''}
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 800, color: tone(cur.net) }}>{money(cur.net)}</span>
            </div>
          )}
        </div>
        {recent === null && <div style={{ color: T.muted, fontSize: 13 }}>Loading</div>}
        {recent !== null && !positions.length && (
          <div style={{ color: T.muted, fontSize: 14, lineHeight: 1.7 }}>
            No fills for this day yet. They show here once they have been sent, or you can paste the trades table with Add fills.
          </div>
        )}
        {positions.length > 0 && (
          <div style={{ display: 'grid', gap: 6 }}>
            {positions.map((p) => (
              <div key={p.key} style={{
                display: 'grid', gridTemplateColumns: mobile ? '20px 48px 1fr auto' : '24px 60px 150px 1fr 90px 90px', gap: 10, alignItems: 'center',
                background: T.card2, border: `1px solid ${T.border}`, borderRadius: 8, padding: '9px 12px', fontFamily: T.mono, fontSize: 13,
              }}>
                <span style={{ color: T.muted }}>{p.n}</span>
                <span style={{ color: T.sub }}>{local(p.t0)}</span>
                <span style={{ fontFamily: T.sans, color: p.side === 'long' ? T.green : T.red }}>
                  {p.side === 'long' ? 'Long' : 'Short'} {p.size}
                  {p.reentry && <span style={{ marginLeft: 8, fontSize: 10, color: T.accent }}>re-entry</span>}
                </span>
                {!mobile && <span style={{ color: T.sub }}>{px(p.entry)} to {p.exit == null ? 'open' : px(p.exit)}</span>}
                {!mobile && <span style={{ color: T.sub, textAlign: 'right' }}>{hold(p.hold_sec)}</span>}
                <span style={{ color: tone(p.pnl), fontWeight: 700, textAlign: 'right' }}>{p.open ? 'open' : money(p.pnl)}</span>
              </div>
            ))}
            <div style={{ marginTop: 10 }}>
              <PriceChart positions={positions} padMin={30} />
            </div>
            <div style={{ marginTop: 6 }}>
              <button onClick={() => onNavigate && onNavigate('sessions')} style={link}>Fills, notes on a position and breakdowns are in Sessions</button>
            </div>
          </div>
        )}
      </Card>

      {images && <Card style={{ padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: charts.length ? 12 : 0 }}>
          <div>
            <div style={label}>Screenshots</div>
            {!mobile && <div style={{ fontSize: 12, color: T.muted, marginTop: 5 }}>Paste one from the clipboard anywhere on this page, or pick a file.</div>}
          </div>
          <input ref={fileRef} type="file" accept="image/*" onChange={(e) => { addChart(e.target.files && e.target.files[0]); e.target.value = '' }} style={{ display: 'none' }} />
          <Btn small onClick={() => fileRef.current && fileRef.current.click()}>Add a screenshot</Btn>
        </div>
        {charts.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: mobile || charts.length === 1 ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
            {charts.map((c) => (
              <div key={c.id} style={{ position: 'relative' }}>
                <a href={chartUrl(c.file_path)} target="_blank" rel="noreferrer">
                  <img src={chartUrl(c.file_path)} alt={`Chart for ${date}`} style={{ width: '100%', borderRadius: 8, border: `1px solid ${T.border}`, display: 'block' }} />
                </a>
                <button onClick={() => removeChart(c)} style={{ position: 'absolute', top: 8, right: 8, background: `${T.card}e0`, color: T.sub, border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 11, padding: '3px 8px', cursor: 'pointer', minHeight: 0, fontFamily: T.sans }}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>}

      <Card style={{ padding: 18 }}>
        <div style={{ ...label, marginBottom: 12 }}>After</div>
        <textarea value={day.review} onChange={(e) => setDay((d) => ({ ...d, review: e.target.value }))} onBlur={save} rows={mobile ? 5 : 6}
          placeholder="How it traded, how you traded it." style={area} />
      </Card>
    </div>
  )
}
