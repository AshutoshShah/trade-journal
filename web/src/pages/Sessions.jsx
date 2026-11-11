import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { ResponsiveContainer, ComposedChart, BarChart, Bar, Cell, Area, ScatterChart, Scatter, XAxis, YAxis, ZAxis, ReferenceLine, Tooltip } from 'recharts'
import { T, today, getZone, zoneLabel } from '../theme'
import { Card, SectionTitle, Btn, Alert } from '../components/UI'
import AddFills from '../components/AddFills'
import PriceChart from '../components/PriceChart'
import { getSessions, tagPosition, uploadSessionBars, removeDayFills, getProfile, updateProfile } from '../db'
import { useMobile } from '../hooks/useMobile'
import {
  money, plain$, pts, px, tone, sum, et, local, hold, shiftDate, weekday, dayLabel, monthLabel,
  applyFees, groupDays, computeStats, afterResult, byMonth, simulate,
  FLAGS, FLAG, addFlags, HEAT, REACH, excursionStats, DEFAULT_LABELS,
} from '../lib'

// Positions are built on the server from the raw fills, flat to flat. This page
// counts them: totals, a running total, and the same positions cut several ways.

const WINDOWS = ['Overnight', 'Premarket', 'First 30 min', 'Morning', 'Afternoon']
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const HOLDS = [
  { label: 'Under 1 minute', test: (x) => x < 60 },
  { label: '1 to 5 minutes', test: (x) => x >= 60 && x < 300 },
  { label: '5 to 15 minutes', test: (x) => x >= 300 && x < 900 },
  { label: 'Over 15 minutes', test: (x) => x >= 900 },
]
const COUNTS = [
  { label: '1 to 3 positions', test: (n) => n <= 3 },
  { label: '4 to 6 positions', test: (n) => n >= 4 && n <= 6 },
  { label: '7 or more', test: (n) => n >= 7 },
]
// The weekday before `d`: on a Monday, the Friday.
const prevWeekday = (d) => { let x = shiftDate(d, -1); while ([0, 6].includes(weekday(x))) x = shiftDate(x, -1); return x }

const RANGES = [
  { id: 'today', label: 'Today', from: () => today(), to: () => today() },
  { id: 'yesterday', label: 'Yesterday', from: () => prevWeekday(today()), to: () => prevWeekday(today()) },
  { id: 'week', label: 'This week', from: () => shiftDate(today(), -((weekday(today()) + 6) % 7)) },
  { id: 'month', label: 'This month', from: () => `${today().slice(0, 7)}-01` },
  { id: '30', label: '30 days', from: () => shiftDate(today(), -29) },
  { id: '90', label: '90 days', from: () => shiftDate(today(), -89) },
  { id: 'all', label: 'All', from: () => undefined },
  { id: 'custom', label: 'Custom' },
]
// Positions from this many days before the range are loaded too, so the flags
// that compare a position with the ones before it read the same in any range.
const LOOKBACK_DAYS = 30
const RANGE_KEY = 'sessions.range'
const remember = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private window */ } }
const recall = (k) => { try { return JSON.parse(localStorage.getItem(k)) } catch { return null } }

const th = { textAlign: 'right', padding: '7px 10px', fontSize: 10, letterSpacing: '.07em', textTransform: 'uppercase', color: T.muted, fontWeight: 600, whiteSpace: 'nowrap', borderBottom: `1px solid ${T.border}` }
const td = { textAlign: 'right', padding: '8px 10px', fontSize: 13, fontFamily: T.mono, color: T.text, whiteSpace: 'nowrap', borderBottom: `1px solid ${T.border}` }
const left = { textAlign: 'left' }
const tip = { background: T.card2, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12 }
const select = { background: T.card2, color: T.text, border: `1px solid ${T.border}`, borderRadius: 7, padding: '7px 8px', fontFamily: T.sans }
const link = { background: 'transparent', border: 'none', color: T.muted, fontSize: 12, cursor: 'pointer', textDecoration: 'underline', fontFamily: T.sans, padding: 0, minHeight: 0 }

function Stat({ label, value, sub, color }) {
  return (
    <div style={{ background: T.card2, border: `1px solid ${T.border}`, borderRadius: 9, padding: '11px 13px', minWidth: 0 }}>
      <div style={{ fontSize: 10, letterSpacing: '.07em', textTransform: 'uppercase', color: T.muted, marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: 19, fontFamily: T.mono, color: color || T.text, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: T.muted, marginTop: 4, lineHeight: 1.4 }}>{sub}</div>}
    </div>
  )
}

// Rows of { label, list } with count, win rate, net and average per position.
function Breakdown({ title, rows, note, unit = 'Positions', onPick, picked }) {
  const shown = rows.filter((r) => r.list.length)
  const val = (p) => p.pnl ?? p.net
  const top = Math.max(1, ...shown.map((r) => Math.abs(sum(r.list, val))))
  return (
    <Card style={{ padding: 18 }}>
      <SectionTitle>{title}</SectionTitle>
      {!shown.length ? <div style={{ color: T.muted, fontSize: 13 }}>Nothing in this range.</div> : (
        <div className="scroll-x">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={{ ...th, ...left }}></th><th style={th}>{unit}</th><th style={th}>Won</th>
              <th style={th}>Net</th><th style={th}>Average</th><th style={{ ...th, width: '26%' }}></th>
            </tr></thead>
            <tbody>{shown.map((r) => {
              const net = sum(r.list, val)
              const won = r.list.filter((p) => val(p) > 0).length
              return (
                <tr key={r.label} onClick={onPick ? () => onPick(r) : undefined} title={r.title}
                  style={{ cursor: onPick ? 'pointer' : 'default', background: picked && picked === r.id ? T.card2 : 'transparent' }}>
                  <td style={{ ...td, ...left, fontFamily: T.sans, color: picked && picked === r.id ? T.accent : T.sub }}>{r.label}</td>
                  <td style={td}>{r.list.length}</td>
                  <td style={td}>{Math.round((won / r.list.length) * 100)}%</td>
                  <td style={{ ...td, color: tone(net) }}>{money(net)}</td>
                  <td style={{ ...td, color: tone(net) }}>{money(net / r.list.length)}</td>
                  <td style={{ ...td, paddingRight: 0 }}>
                    <div style={{ height: 8, borderRadius: 4, background: T.card3, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${(Math.abs(net) / top) * 100}%`, background: net >= 0 ? T.green : T.red, opacity: 0.75 }} />
                    </div>
                  </td>
                </tr>
              )
            })}</tbody>
          </table>
        </div>
      )}
      {note && <div style={{ color: T.muted, fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>{note}</div>}
    </Card>
  )
}

// Weeks down, weekdays across; each cell is that day's net.
function DayGrid({ days, onPick }) {
  const byDate = new Map(days.map((d) => [d.date, d]))
  const first = days[days.length - 1].date, last = days[0].date
  const mondayOf = (d) => shiftDate(d, -((weekday(d) + 6) % 7))
  const weeks = []
  for (let w = mondayOf(last); w >= mondayOf(first) && weeks.length < 26; w = shiftDate(w, -7)) weeks.push(w)
  const top = Math.max(1, ...days.map((d) => Math.abs(d.net)))
  const head = { fontSize: 10, letterSpacing: '.07em', textTransform: 'uppercase', color: T.muted }
  return (
    <Card style={{ padding: 18 }}>
      <SectionTitle>Days</SectionTitle>
      <div className="scroll-x">
        <div style={{ display: 'grid', gridTemplateColumns: '64px repeat(5, minmax(70px, 1fr)) 84px', gap: 5, minWidth: 520 }}>
          <span />
          {WEEKDAYS.map((d) => <span key={d} style={{ ...head, textAlign: 'center' }}>{d.slice(0, 3)}</span>)}
          <span style={{ ...head, textAlign: 'right' }}>Week</span>
          {weeks.map((w) => {
            const cells = [0, 1, 2, 3, 4].map((i) => byDate.get(shiftDate(w, i)))
            const wk = cells.reduce((s, c) => s + (c ? c.net : 0), 0)
            const any = cells.some(Boolean)
            return [
              <span key={w} style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, alignSelf: 'center' }}>{dayLabel(w, { day: 'numeric', month: 'short' })}</span>,
              ...cells.map((c, i) => (
                <button key={w + i} onClick={() => c && onPick(c.date)} disabled={!c} title={c ? `${dayLabel(c.date)}: ${c.closed.length} positions` : ''} style={{
                  minHeight: 40, borderRadius: 6, border: `1px solid ${c ? (c.net >= 0 ? T.green : T.red) + '55' : T.border}`,
                  background: c ? `${c.net >= 0 ? T.green : T.red}${Math.round(18 + (Math.abs(c.net) / top) * 60).toString(16).padStart(2, '0')}` : 'transparent',
                  color: T.text, fontFamily: T.mono, fontSize: 12, cursor: c ? 'pointer' : 'default', padding: '4px 2px',
                }}>{c ? money(c.net) : ''}</button>
              )),
              <span key={`${w}w`} style={{ fontFamily: T.mono, fontSize: 12, color: any ? tone(wk) : T.label, textAlign: 'right', alignSelf: 'center', fontWeight: 700 }}>{any ? money(wk) : ''}</span>,
            ]
          })}
        </div>
      </div>
    </Card>
  )
}

function Months({ rows }) {
  return (
    <Card style={{ padding: 18 }}>
      <SectionTitle>By month</SectionTitle>
      <div className="scroll-x">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={{ ...th, ...left }}></th><th style={th}>Days</th><th style={th}>Days up</th><th style={th}>Positions</th>
            <th style={th}>Won</th><th style={th}>Best day</th><th style={th}>Worst day</th><th style={th}>Net</th>
          </tr></thead>
          <tbody>{rows.map((m) => (
            <tr key={m.ym}>
              <td style={{ ...td, ...left, fontFamily: T.sans, color: T.sub }}>{monthLabel(m.ym)}</td>
              <td style={td}>{m.days}</td>
              <td style={td}>{m.upDays}</td>
              <td style={td}>{m.positions}</td>
              <td style={td}>{Math.round(m.won * 100)}%</td>
              <td style={{ ...td, color: tone(m.best) }}>{money(m.best)}</td>
              <td style={{ ...td, color: tone(m.worst) }}>{money(m.worst)}</td>
              <td style={{ ...td, color: tone(m.net), fontWeight: 700 }}>{money(m.net)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </Card>
  )
}

function exportCsv(positions) {
  const cols = ['date', 'n', 'window', 'account', 'instrument', 'side', 'size', 'entry', 'exit', 'points', 'gross', 'fee', 'pnl', 'hold_sec', 'clips_in', 'clips_out', 'best_pts', 'worst_pts', 'best_usd', 'worst_usd', 'after_for', 'after_against', 'reentry', 'review', 'flags', 'setup', 'note']
  const cell = (v) => { const x = v == null ? '' : String(v); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x }
  const rows = positions.map((p) => [...cols.map((c) => cell(c === 'flags' ? (p.flags || []).map((k) => FLAG[k].label).join('; ') : p[c])), new Date(p.t0).toISOString(), new Date(p.t1).toISOString()].join(','))
  const blob = new Blob([`${[...cols, 'opened_utc', 'closed_utc'].join(',')}\n${rows.join('\n')}`], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = `positions-${today()}.csv`; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

const flagChip = (k) => {
  const c = k === 'review' ? T.accent : T.yellow
  return { display: 'inline-block', margin: '1px 4px 1px 0', fontSize: 10, color: c, border: `1px solid ${c}55`, borderRadius: 4, padding: '1px 5px', fontFamily: T.sans, whiteSpace: 'nowrap' }
}

function PositionRow({ p, open, onToggle, onTag, mobile, labels }) {
  const flags = p.flags || []
  const [note, setNote] = useState(p.note || '')
  // The table scrolls sideways; the open panel stays the width of what is on
  // screen and does not scroll with it.
  const panel = useRef(null)
  const [panelW, setPanelW] = useState(null)
  useEffect(() => {
    const sc = open && panel.current && panel.current.closest('.scroll-x')
    if (!sc) return undefined
    const measure = () => setPanelW(sc.clientWidth - 28)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(sc)
    return () => ro.disconnect()
  }, [open])
  useEffect(() => { setNote(p.note || '') }, [p.note])
  const badge = (text, color) => <span style={{ marginLeft: 8, fontSize: 10, color, border: `1px solid ${color}55`, borderRadius: 4, padding: '1px 5px' }}>{text}</span>
  const pick = (value, extra = {}) => (
    <select value={value} onChange={(e) => onTag(p, { setup: e.target.value, note })} style={{ ...select, color: value ? T.text : T.muted, padding: '4px 6px', ...extra }}>
      <option value="">No label</option>
      {[...new Set([...labels, ...(p.setup ? [p.setup] : [])])].map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  )
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer', background: open ? T.card2 : 'transparent' }}>
        <td style={{ ...td, ...left, color: T.muted }}>{p.n}</td>
        <td style={{ ...td, ...left }}>
          {local(p.t0, !mobile)}
          {!mobile && <span style={{ color: T.muted, marginLeft: 8 }}>{et(p.t0)} ET</span>}
        </td>
        <td style={{ ...td, ...left, fontFamily: T.sans, color: p.side === 'long' ? T.green : T.red }}>
          {p.side === 'long' ? 'Long' : 'Short'}
          {p.reentry && badge('re-entry', T.accent)}
          {p.open && badge('not flat', T.yellow)}
          {p.note && !open && <span style={{ marginLeft: 8, color: T.muted, fontSize: 11 }}>note</span>}
          {mobile && flags.length > 0 && badge(flags.length === 1 ? FLAG[flags[0]].short : `${flags.length} flags`, flags.includes('review') ? T.accent : T.yellow)}
        </td>
        <td style={td}>{p.size}</td>
        {!mobile && <td style={td}>{px(p.entry)}</td>}
        {!mobile && <td style={td}>{px(p.exit)}</td>}
        <td style={{ ...td, color: tone(p.points) }}>{pts(p.points)}</td>
        <td style={{ ...td, color: tone(p.pnl), fontWeight: 700 }}>{money(p.pnl)}</td>
        <td style={td}>{hold(p.hold_sec)}</td>
        {!mobile && <td style={{ ...td, color: T.sub }}>{p.clips_in} / {p.clips_out}</td>}
        {!mobile && <td style={{ ...td, color: T.sub }}>{p.best_pts == null ? '' : `${pts(p.best_pts)} / ${pts(p.worst_pts)}`}</td>}
        {!mobile && <td style={{ ...td, ...left }} onClick={(e) => e.stopPropagation()}>{pick(p.setup || '', { minWidth: 130 })}</td>}
        {!mobile && (
          <td style={{ ...td, ...left, whiteSpace: 'normal', minWidth: 230 }}>
            {flags.map((k) => <span key={k} title={`${FLAG[k].label}. ${FLAG[k].help}`} style={flagChip(k)}>{FLAG[k].short}</span>)}
          </td>
        )}
      </tr>
      {open && (
        <tr>
          <td colSpan={mobile ? 7 : 13} style={{ padding: '12px 14px 16px', background: T.card2, borderBottom: `1px solid ${T.border}` }}>
            <div ref={panel} style={{ position: 'sticky', left: 14, width: panelW || undefined }}>
            <div style={{ marginBottom: 14 }}><PriceChart positions={[p]} padMin={15} title={`${dayLabel(p.date)}, position ${p.n}`} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: mobile ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(0, 1fr)', gap: 18 }}>
              <div>
                <div style={{ fontSize: 10, letterSpacing: '.07em', textTransform: 'uppercase', color: T.muted, marginBottom: 6 }}>
                  Fills · {p.instrument}{p.account ? ` · ${p.account}` : ''}
                </div>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <tbody>{p.fills.map((f, i) => (
                    <tr key={i}>
                      <td style={{ ...td, ...left, borderBottom: 'none', padding: '3px 10px 3px 0', color: T.sub }}>{local(f.t, true)}</td>
                      <td style={{ ...td, ...left, borderBottom: 'none', padding: '3px 10px', fontFamily: T.sans, color: f.side === 'buy' ? T.green : T.red }}>{f.side === 'buy' ? 'Buy' : 'Sell'}</td>
                      <td style={{ ...td, borderBottom: 'none', padding: '3px 10px' }}>{f.qty}</td>
                      <td style={{ ...td, borderBottom: 'none', padding: '3px 0 3px 10px' }}>{px(f.price)}</td>
                    </tr>
                  ))}</tbody>
                </table>
                <div style={{ fontSize: 12, color: T.sub, fontFamily: T.mono, marginTop: 8, lineHeight: 1.7 }}>
                  {mobile && <>In {px(p.entry)}, out {px(p.exit)}, {et(p.t0)} ET<br /></>}
                  {p.best_pts != null && <>Went {pts(p.best_pts)} for and {pts(p.worst_pts)} against the average entry<br /></>}
                  {p.best_usd != null && <>Open P&amp;L ran from {money(p.worst_usd)} to {money(p.best_usd)}<br /></>}
                  {p.after_for != null && <>In the 15 minutes after the exit: {p.after_for.toFixed(1)} further, {p.after_against.toFixed(1)} back<br /></>}
                  {p.fee > 0 && <>Before commissions {money(p.gross)}, commissions {plain$(p.fee)}</>}
                </div>
              </div>
              <div onClick={(e) => e.stopPropagation()}>
                {flags.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 10, letterSpacing: '.07em', textTransform: 'uppercase', color: T.muted, marginBottom: 6 }}>Flags</div>
                    {flags.map((k) => (
                      <div key={k} style={{ fontSize: 13, color: T.sub, lineHeight: 1.5, marginBottom: 4 }}>
                        <span style={{ color: T.text }}>{FLAG[k].label}.</span> {FLAG[k].help}
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ marginBottom: 10 }}>
                  <Btn small accent={p.review} onClick={() => onTag(p, { review: !p.review })}>{p.review ? 'Marked for review' : 'Mark for review'}</Btn>
                </div>
                {mobile && pick(p.setup || '', { width: '100%', padding: 8, marginBottom: 8 })}
                <div style={{ fontSize: 10, letterSpacing: '.07em', textTransform: 'uppercase', color: T.muted, marginBottom: 6 }}>Note</div>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => { if (note !== (p.note || '')) onTag(p, { note }) }}
                  rows={3} placeholder="Optional" style={{ width: '100%', background: T.card, color: T.text, border: `1px solid ${T.border}`, borderRadius: 6, padding: '8px 10px', fontFamily: T.sans, resize: 'vertical' }} />
              </div>
            </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function Commissions({ fees, onSave }) {
  const [edit, setEdit] = useState(false)
  const [v, setV] = useState(fees)
  useEffect(() => { setV(fees) }, [fees])
  const on = Object.values(fees).some((x) => parseFloat(x) > 0)
  const input = (k) => (
    <label style={{ fontSize: 13, color: T.sub }}>{k}{' '}
      <input value={v[k] || ''} onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value }))} inputMode="decimal" placeholder="0.00"
        style={{ ...select, width: 80, fontFamily: T.mono }} />
    </label>
  )
  if (!edit) {
    return (
      <span>
        {on ? `P&L is after commissions (${['MNQ', 'NQ'].filter((k) => parseFloat(fees[k]) > 0).map((k) => `${k} $${parseFloat(fees[k]).toFixed(2)}`).join(', ')} per contract, per side). ` : 'P&L is before commissions. '}
        <button style={link} onClick={() => setEdit(true)}>{on ? 'Change' : 'Set commissions'}</button>
      </span>
    )
  }
  return (
    <span style={{ display: 'inline-flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      Dollars per contract, per side: {input('MNQ')} {input('NQ')}
      <Btn small accent onClick={() => { onSave(v); setEdit(false) }}>Save</Btn>
      <Btn small onClick={() => { setV(fees); setEdit(false) }}>Cancel</Btn>
    </span>
  )
}

export default function Sessions() {
  const mobile = useMobile()
  const saved = recall(RANGE_KEY) || {}
  const [range, setRange] = useState(RANGES.some((r) => r.id === saved.id) ? saved.id : '30')
  const [custom, setCustom] = useState({ from: saved.from || shiftDate(today(), -6), to: saved.to || today() })
  const [limits, setLimits] = useState({})
  const [labels, setLabels] = useState(DEFAULT_LABELS)
  const [flagFilter, setFlagFilter] = useState('')
  const [scatterBy, setScatterBy] = useState('worst')
  const [data, setData] = useState(null)
  const [fees, setFees] = useState({})
  const [err, setErr] = useState(null)
  const [notice, setNotice] = useState(null)
  const [openKey, setOpenKey] = useState(null)
  const [adding, setAdding] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [account, setAccount] = useState('')
  const fileRef = useRef(null)

  const span = useMemo(() => {
    if (range === 'custom') {
      const [a, b] = [custom.from, custom.to].sort()
      return { from: a || undefined, to: b || undefined }
    }
    const r = RANGES.find((x) => x.id === range)
    return { from: r.from(), to: r.to ? r.to() : undefined }
  }, [range, custom])
  useEffect(() => { remember(RANGE_KEY, { id: range, ...custom }) }, [range, custom])

  const load = useCallback(() => {
    setErr(null)
    getSessions({ from: span.from && shiftDate(span.from, -LOOKBACK_DAYS), to: span.to }).then(setData).catch((e) => setErr(e.message))
  }, [span])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    getProfile().then((p) => {
      setFees((p && p.fees) || {}); setLimits((p && p.model && p.model.limits) || {})
      if (p && Array.isArray(p.labels) && p.labels.length) setLabels(p.labels)
    }).catch(() => {})
  }, [])

  const inSpan = useCallback((p) => (!span.from || p.date >= span.from) && (!span.to || p.date <= span.to), [span])
  const accounts = useMemo(() => (data ? [...new Set(data.positions.map((p) => p.account).filter(Boolean))] : []), [data])
  // Flags are worked out over everything loaded, lookback included, then cut to the range.
  const all = useMemo(() => {
    if (!data) return []
    const mine = applyFees(data.positions.filter((p) => !account || p.account === account), fees)
    const flagged = new Map(addFlags(mine.filter((p) => !p.open), limits).map((p) => [p.key, p]))
    return mine.filter(inSpan).map((p) => flagged.get(p.key) || { ...p, flags: [] })
  }, [data, account, fees, limits, inSpan])
  const positions = useMemo(() => all.filter((p) => !p.open), [all])
  const days = useMemo(() => groupDays(all), [all])
  const shownDays = useMemo(() => {
    if (!flagFilter) return days
    const keep = (p) => (flagFilter === 'any' ? p.flags.length > 0 : p.flags.includes(flagFilter))
    return days.map((d) => ({ ...d, total: d.list.length, list: d.list.filter(keep) })).filter((d) => d.list.length)
  }, [days, flagFilter])
  const ex = useMemo(() => excursionStats(positions), [positions])
  const tradedDays = useMemo(() => days.filter((d) => d.closed.length), [days])
  const s = useMemo(() => computeStats(positions, tradedDays), [positions, tradedDays])
  const sim = useMemo(() => simulate(tradedDays.map((d) => d.net)), [tradedDays])
  const months = useMemo(() => byMonth(tradedDays), [tradedDays])

  // `patch` holds any of setup, note and review; the rest are kept.
  const onTag = useCallback((p, patch) => {
    const next = { setup: p.setup || '', note: p.note || '', review: !!p.review, ...patch }
    setData((d) => ({ ...d, positions: d.positions.map((x) => (x.key === p.key ? { ...x, ...next } : x)) }))
    tagPosition(p.key, next.setup, next.note, next.review).catch((e) => setErr(e.message))
  }, [])

  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setUploading(true); setNotice(null); setErr(null)
    try {
      const r = await uploadSessionBars(file, 'NQ')
      const d = (sec) => new Date(sec * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: getZone() })
      setNotice(`${r.rows.toLocaleString('en-US')} one-minute bars added, ${d(r.from)} ${local(r.from * 1000)} to ${d(r.to)} ${local(r.to * 1000)} ${zoneLabel()}.`)
      load()
    } catch (x) { setErr(`The file was not added. ${x.message}`) }
    setUploading(false)
  }
  const saveFees = (v) => { setFees(v); updateProfile({ fees: v }).catch((e) => setErr(e.message)) }
  const pickDay = (d) => { const el = document.getElementById(`day-${d}`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  const removeDay = async (d) => {
    if (!window.confirm(`Remove the fills stored for ${dayLabel(d)}? Notes and charts for the day are kept.`)) return
    try { await removeDayFills(d); setNotice(`Fills for ${dayLabel(d)} removed.`); load() } catch (e) { setErr(e.message) }
  }

  const byNumber = [1, 2, 3, 4, 5].map((n) => ({ label: `Position ${n}`, list: positions.filter((p) => p.n === n) }))
    .concat([{ label: 'Position 6 and later', list: positions.filter((p) => p.n >= 6) }])
  const byWindow = WINDOWS.map((w) => ({ label: w, list: positions.filter((p) => p.window === w) }))
  const byAttempt = [{ label: 'First attempt', list: positions.filter((p) => !p.reentry) }, { label: 'Re-entry', list: positions.filter((p) => p.reentry) }]
  const byHold = HOLDS.map((h) => ({ label: h.label, list: positions.filter((p) => h.test(p.hold_sec)) }))
  const bySide = [{ label: 'Long', list: positions.filter((p) => p.side === 'long') }, { label: 'Short', list: positions.filter((p) => p.side === 'short') }]
  const bySize = [...new Set(positions.map((p) => p.size))].sort((a, b) => a - b).map((z) => ({ label: `${z} ${z === 1 ? 'contract' : 'contracts'}`, list: positions.filter((p) => p.size === z) }))
  const byWeekday = WEEKDAYS.map((d, i) => ({ label: d, list: positions.filter((p) => weekday(p.date) === i + 1) }))
  const bySetup = [...new Set([...labels, ...positions.map((p) => p.setup).filter(Boolean)])].map((x) => ({ label: x, list: positions.filter((p) => p.setup === x) })).concat([{ label: 'No label', list: positions.filter((p) => !p.setup) }])
  const byCount = COUNTS.map((c) => ({ label: c.label, list: tradedDays.filter((d) => c.test(d.closed.length)) }))
  const labelled = positions.some((p) => p.setup)
  const flaggedList = positions.filter((p) => p.flags.length)
  const byFlag = FLAGS.map((f) => ({ id: f.key, label: f.label, title: f.help, list: positions.filter((p) => p.flags.includes(f.key)) }))
    .concat([{ id: 'none', label: 'No flags', list: positions.filter((p) => !p.flags.length) }])
  const measured = positions.filter((p) => p.best_pts != null)
  const byHeat = HEAT.map((h) => ({ label: h.label, list: measured.filter((p) => h.test(p.worst_pts)) }))
  const byReach = REACH.map((h) => ({ label: h.label, list: measured.filter((p) => h.test(p.best_pts)) }))
  const scatter = measured.map((p) => ({ x: scatterBy === 'worst' ? p.worst_pts : p.best_pts, y: p.points, z: p.size, win: p.pnl > 0, label: `${dayLabel(p.date, { day: 'numeric', month: 'short' })}, position ${p.n}`, pnl: p.pnl }))
  const pickFlag = (r) => { const id = r.id === 'none' ? '' : r.id; setFlagFilter((f) => (f === id ? '' : id)); if (id) setTimeout(() => { const el = document.getElementById('positions'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, 0) }
  const onePt = (v) => (v == null ? 'n/a' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`)
  const chart = [...tradedDays].reverse().map((d) => ({ date: dayLabel(d.date, { day: 'numeric', month: 'short' }), net: Math.round(d.net) }))
  const nqBars = data && data.bars.find((b) => b.root === 'NQ')
  const ratio = (v) => (v == null ? 'n/a' : v.toFixed(2))

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {RANGES.map((r) => (
            <button key={r.id} onClick={() => setRange(r.id)} style={{
              background: range === r.id ? `${T.accent}18` : T.card2, color: range === r.id ? T.accent : T.sub,
              border: `1px solid ${range === r.id ? T.accent : T.border}`, borderRadius: 7, padding: '6px 12px',
              fontFamily: T.sans, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}>{r.label}</button>
          ))}
          {range === 'custom' && (
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', color: T.muted, fontSize: 13 }}>
              <input type="date" value={custom.from} max={today()} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} style={{ ...select, colorScheme: 'dark' }} aria-label="From" />
              to
              <input type="date" value={custom.to} max={today()} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} style={{ ...select, colorScheme: 'dark' }} aria-label="To" />
            </span>
          )}
          {range !== 'custom' && span.from && (
            <span style={{ color: T.muted, fontSize: 12, marginLeft: 4 }}>
              {span.from === span.to ? dayLabel(span.from) : `${dayLabel(span.from, { day: 'numeric', month: 'short' })} to ${dayLabel(span.to || today(), { day: 'numeric', month: 'short' })}`}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: 'none' }} />
          {accounts.length > 1 && (
            <select value={account} onChange={(e) => setAccount(e.target.value)} style={select}>
              <option value="">All accounts</option>
              {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          )}
          {positions.length > 0 && <Btn small onClick={() => exportCsv(all)}>Export</Btn>}
          <Btn small onClick={() => fileRef.current && fileRef.current.click()} disabled={uploading}>{uploading ? 'Uploading' : 'Add price bars'}</Btn>
          <Btn small accent onClick={() => setAdding((v) => !v)}>Add fills</Btn>
        </div>
      </div>

      {adding && <AddFills onClose={() => setAdding(false)} onDone={(m) => { setNotice(m); setAdding(false); load() }} />}
      {notice && <Alert type="ok">{notice}</Alert>}
      {err && <Alert type="danger">{err}</Alert>}
      {!data && !err && <div style={{ color: T.muted, padding: 30, textAlign: 'center' }}>Loading</div>}

      {data && !all.length && (
        <Card>
          <div style={{ color: T.sub, fontSize: 14, lineHeight: 1.7 }}>
            No fills in this range. A day appears here once its fills have been sent to the journal, or pasted in with Add fills.
          </div>
        </Card>
      )}

      {s && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: mobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(6, minmax(0, 1fr))', gap: 10 }}>
            <Stat label="Net" value={money(s.net)} color={tone(s.net)} sub={s.days === 1 ? 'One day' : `${s.greenDays} of ${s.days} days up`} />
            <Stat label="Average day" value={money(s.avgDay)} color={tone(s.avgDay)} sub={s.days > 1 ? `best ${money(s.bestDay)}, worst ${money(s.worstDay)}` : ''} />
            <Stat label="Won" value={`${Math.round(s.winRate * 100)}%`} sub={`${s.n} positions, ${s.perDay.toFixed(1)} a day`} />
            <Stat label="Per position" value={money(s.expectancy)} color={tone(s.expectancy)} sub={`profit factor ${ratio(s.profitFactor)}`} />
            <Stat label="Average win" value={money(s.avgWin)} color={T.green} sub={`largest ${money(s.bestPos)}`} />
            <Stat label="Average loss" value={money(s.avgLoss)} color={T.red} sub={`largest ${money(s.worstPos)}; win to loss ${ratio(s.payoff)}`} />
            <Stat label="Largest drawdown" value={plain$(-s.maxDD)} color={s.maxDD ? T.red : T.sub} sub={s.curDD > 0 ? `now ${plain$(s.curDD)} below the high` : 'at the high now'} />
            <Stat label="Given back in a day" value={plain$(s.gaveBack)} sub="average, from the day's high to its close" />
            <Stat label="Streaks" value={`${s.streak.bestW} / ${s.streak.bestL}`} sub={`most wins / losses in a row${s.streak.curL > 1 ? `; on ${s.streak.curL} losses now` : s.streak.curW > 1 ? `; on ${s.streak.curW} wins now` : ''}`} />
            <Stat label="Hold" value={hold(Math.round(s.medHold))} sub={`winners ${hold(Math.round(s.medHoldWin ?? 0))}, losers ${hold(Math.round(s.medHoldLoss ?? 0))}`} />
            <Stat label="From re-entries" value={money(s.reNet)} color={tone(s.reNet)}
              sub={s.net > 0 && s.reNet > 0 ? `${Math.round((s.reNet / s.net) * 100)}% of net, ${s.reCount} taken` : `${s.reCount} taken`} />
            <Stat label="Flagged" value={`${flaggedList.length}`} color={flaggedList.length ? T.yellow : T.sub}
              sub={flaggedList.length ? `net ${money(sum(flaggedList, (p) => p.pnl))}; unflagged ${money(s.net - sum(flaggedList, (p) => p.pnl))}` : 'nothing flagged'} />
          </div>

          {s.curve.length > 2 && (
            <Card style={{ padding: 18 }}>
              <SectionTitle>Running total and drawdown</SectionTitle>
              <div style={{ height: 230 }}>
                <ResponsiveContainer>
                  <ComposedChart data={s.curve} margin={{ top: 4, right: 4, left: -6, bottom: 0 }}>
                    <XAxis dataKey="i" tick={{ fill: T.muted, fontSize: 11 }} axisLine={{ stroke: T.border }} tickLine={false} />
                    <YAxis tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} />
                    <ReferenceLine y={0} stroke={T.borderLight} />
                    <Tooltip formatter={(v, name) => [name === 'dd' ? plain$(v) : money(v), name === 'dd' ? 'Below the high' : 'Total']}
                      labelFormatter={(l, x) => (x && x[0] ? `Position ${l}, ${x[0].payload.date}` : '')} contentStyle={tip} labelStyle={{ color: T.sub }} />
                    <Area isAnimationActive={false} type="stepAfter" dataKey="dd" stroke="none" fill={T.red} fillOpacity={0.28} />
                    <Area isAnimationActive={false} type="stepAfter" dataKey="net" stroke={T.accent} strokeWidth={2} fill={T.accent} fillOpacity={0.08} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div style={{ color: T.muted, fontSize: 12, marginTop: 6 }}>Gold is the total after each position. Red is how far it sat below its high at that point.</div>
            </Card>
          )}

          {tradedDays.length > 1 && <DayGrid days={tradedDays} onPick={pickDay} />}

          {chart.length > 1 && (
            <Card style={{ padding: 18 }}>
              <SectionTitle>Net by day</SectionTitle>
              <div style={{ height: 180 }}>
                <ResponsiveContainer>
                  <BarChart data={chart} margin={{ top: 4, right: 4, left: -6, bottom: 0 }}>
                    <XAxis dataKey="date" tick={{ fill: T.muted, fontSize: 11 }} axisLine={{ stroke: T.border }} tickLine={false} />
                    <YAxis tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} />
                    <ReferenceLine y={0} stroke={T.borderLight} />
                    <Tooltip cursor={{ fill: `${T.accent}10` }} formatter={(v) => [money(v), 'Net']} contentStyle={tip} labelStyle={{ color: T.sub }} />
                    <Bar isAnimationActive={false} dataKey="net" radius={[3, 3, 0, 0]}>
                      {chart.map((d, i) => <Cell key={i} fill={d.net >= 0 ? T.green : T.red} fillOpacity={0.8} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: mobile ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
            <Breakdown title="By position number in the day" rows={byNumber} />
            <Breakdown title="By time of entry" rows={byWindow}
              note="Named for the New York day: premarket is before the 9:30 ET open, morning runs to noon ET." />
            <Breakdown title="First attempts and re-entries" rows={byAttempt}
              note="A re-entry is a position on the same side, opened within 5 minutes of a losing one and within 40 points of its exit." />
            <Breakdown title="The next position" rows={afterResult(tradedDays)} note="How the position after a win did, against the position after a loss, within the same day." />
            <Breakdown title="By hold time" rows={byHold} />
            <Breakdown title="By side" rows={bySide} />
            <Breakdown title="By size" rows={bySize} />
            <Breakdown title="Days, by how many positions were taken" rows={byCount} unit="Days" />
            {tradedDays.length > 4 && <Breakdown title="By weekday" rows={byWeekday} />}
            {labelled && <Breakdown title="By label" rows={bySetup} />}
          </div>

          <Breakdown title="Flags" rows={byFlag} onPick={pickFlag} picked={flagFilter}
            note="Markers for a second look; a flagged position can still be a good trade. Tap a row to list those positions below. Size, risk, daily stop and positions per day come from How I trade where they are set." />

          <Card style={{ padding: 18 }}>
            <SectionTitle>How far positions went for and against</SectionTitle>
            {!ex ? (
              <div style={{ color: T.muted, fontSize: 13 }}>Needs one-minute bars for these days. They are fetched on their own for the last 30 days.</div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: mobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(5, minmax(0, 1fr))', gap: 10, marginBottom: 16 }}>
                  <Stat label="Winners went against" value={onePt(ex.winHeat)} sub={ex.winHeat90 != null ? `median points; 9 in 10 went no more than ${ex.winHeat90.toFixed(1)} against` : 'median points'} />
                  <Stat label="Losers went for" value={onePt(ex.lossReach)} sub={`median points; ${ex.lossesUp} of ${ex.losses} were 8 or more up`} />
                  <Stat label="Losers went against" value={onePt(ex.lossHeat)} sub="median points at the worst" />
                  <Stat label="Kept of the move" value={ex.kept == null ? 'n/a' : `${Math.round(ex.kept * 100)}%`} sub="winners: P&L against their best open profit" />
                  <Stat label="After the exit" value={onePt(ex.winRanOn)} sub={`winners, median points further in 15 minutes${ex.lossCameBack != null ? `; losers came back ${ex.lossCameBack.toFixed(1)}` : ''}`} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                  <span style={{ color: T.sub, fontSize: 13 }}>Each dot is a position: {scatterBy === 'worst' ? 'how far it went against' : 'how far it went for'} across, its result up the side, both in points.</span>
                  <span style={{ display: 'flex', gap: 6 }}>
                    {[['worst', 'Against'], ['best', 'For']].map(([k, l]) => (
                      <button key={k} onClick={() => setScatterBy(k)} style={{ ...select, padding: '4px 10px', cursor: 'pointer', color: scatterBy === k ? T.accent : T.sub, borderColor: scatterBy === k ? T.accent : T.border }}>{l}</button>
                    ))}
                  </span>
                </div>
                <div style={{ height: 260 }}>
                  <ResponsiveContainer>
                    <ScatterChart margin={{ top: 8, right: 8, left: -6, bottom: 0 }}>
                      <XAxis type="number" dataKey="x" domain={[(v) => Math.floor(v - 2), (v) => Math.ceil(v + 2)]} name={scatterBy === 'worst' ? 'Against' : 'For'} tick={{ fill: T.muted, fontSize: 11 }} axisLine={{ stroke: T.border }} tickLine={false} />
                      <YAxis type="number" dataKey="y" domain={[(v) => Math.floor(v - 4), (v) => Math.ceil(v + 4)]} name="Result" tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                      <ZAxis type="number" dataKey="z" range={[30, 220]} name="Size" />
                      <ReferenceLine y={0} stroke={T.borderLight} />
                      <ReferenceLine x={0} stroke={T.borderLight} />
                      <Tooltip cursor={false} contentStyle={tip} content={({ payload }) => {
                        const d = payload && payload[0] && payload[0].payload
                        return d ? (
                          <div style={{ ...tip, padding: '8px 10px', color: T.text }}>
                            <div style={{ color: T.sub, marginBottom: 4 }}>{d.label}</div>
                            <div>{scatterBy === 'worst' ? 'Against' : 'For'} {d.x.toFixed(1)}, result {d.y.toFixed(1)} points</div>
                            <div>Size {d.z}, {money(d.pnl)}</div>
                          </div>
                        ) : null
                      }} />
                      <Scatter isAnimationActive={false} data={scatter.filter((d) => d.win)} fill={T.green} fillOpacity={0.7} />
                      <Scatter isAnimationActive={false} data={scatter.filter((d) => !d.win)} fill={T.red} fillOpacity={0.7} />
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ color: T.muted, fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
                  Larger dots are larger positions. Points are per contract, measured from the average entry. {ex.n < ex.of ? `${ex.of - ex.n} of ${ex.of} positions are left out: opened and closed inside one minute, or no bars yet.` : ''}
                </div>
              </>
            )}
          </Card>

          {ex && (
            <div style={{ display: 'grid', gridTemplateColumns: mobile ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
              <Breakdown title="By how far it went against" rows={byHeat} note="The furthest a position went against its average entry while on." />
              <Breakdown title="By how far it went for" rows={byReach} note="The furthest a position went in its favour while on." />
            </div>
          )}

          {(months.length > 1 || tradedDays.length > 4) && <Months rows={months} />}

          {sim && (
            <Card style={{ padding: 18 }}>
              <SectionTitle>If the next {sim.horizon} trading days look like these</SectionTitle>
              <div style={{ display: 'grid', gridTemplateColumns: mobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(5, minmax(0, 1fr))', gap: 10 }}>
                <Stat label="Ends up" value={`${Math.round(sim.up * 100)}%`} sub="of the runs" />
                <Stat label="Middle outcome" value={money(sim.p50)} color={tone(sim.p50)} />
                <Stat label="Poor run" value={money(sim.p5)} color={tone(sim.p5)} sub="1 in 20 ends below this" />
                <Stat label="Good run" value={money(sim.p95)} color={tone(sim.p95)} sub="1 in 20 ends above this" />
                <Stat label="Drawdown on the way" value={plain$(-sim.dd50)} color={T.red} sub={`typical; 1 in 20 reaches ${plain$(-sim.dd95)}`} />
              </div>
              <div style={{ color: T.muted, fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
                Made by drawing {sim.horizon} days at random from the {s.days} days in this range, 3,000 times. It describes the days so far and assumes the next ones are like them.
              </div>
            </Card>
          )}
        </>
      )}

      {days.length > 0 && (
        <div id="positions" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', scrollMarginTop: 76 }}>
          <span style={{ color: T.sub, fontSize: 13 }}>Show</span>
          <select value={flagFilter} onChange={(e) => setFlagFilter(e.target.value)} style={select}>
            <option value="">Every position</option>
            <option value="any">Any flag</option>
            {FLAGS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          {flagFilter && <span style={{ color: T.muted, fontSize: 12 }}>{sum(shownDays, (d) => d.list.length)} positions on {shownDays.length} {shownDays.length === 1 ? 'day' : 'days'}</span>}
        </div>
      )}

      {shownDays.map((d) => (
        <Card key={d.date} style={{ padding: mobile ? '14px 10px' : 18 }}>
          <span id={`day-${d.date}`} style={{ position: 'relative', top: -76, display: 'block' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10, padding: mobile ? '0 4px' : 0 }}>
            <div>
              <span style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{dayLabel(d.date)}</span>
              <span style={{ fontSize: 12, color: T.muted, marginLeft: 10 }}>
                {flagFilter ? `${d.list.length} of ${d.total} positions` : `${d.list.length} ${d.list.length === 1 ? 'position' : 'positions'}`}, {local(d.list[0].t0)} to {local(d.list[d.list.length - 1].t1)} {zoneLabel()}
                {d.peak > 0 && d.gaveBack > 0 ? `, high of the day ${money(d.peak)}` : ''}
              </span>
            </div>
            <span style={{ display: 'flex', gap: 14, alignItems: 'baseline' }}>
              <button onClick={() => removeDay(d.date)} style={link}>Remove</button>
              <span style={{ fontFamily: T.mono, fontSize: 17, fontWeight: 800, color: tone(d.net) }}>{money(d.net)}</span>
            </span>
          </div>
          <div className="scroll-x">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={{ ...th, ...left }}>#</th>
                <th style={{ ...th, ...left }}>In ({zoneLabel()})</th>
                <th style={{ ...th, ...left }}>Side</th>
                <th style={th}>Size</th>
                {!mobile && <th style={th}>Avg in</th>}
                {!mobile && <th style={th}>Avg out</th>}
                <th style={th}>Points</th>
                <th style={th}>P&amp;L</th>
                <th style={th}>Held</th>
                {!mobile && <th style={th}>Clips in / out</th>}
                {!mobile && <th style={th}>Best / worst</th>}
                {!mobile && <th style={{ ...th, ...left }}>Label</th>}
                {!mobile && <th style={{ ...th, ...left }}>Flags</th>}
              </tr></thead>
              <tbody>
                {d.list.map((p) => (
                  <PositionRow key={p.key} p={p} mobile={mobile} open={openKey === p.key}
                    onToggle={() => setOpenKey(openKey === p.key ? null : p.key)} onTag={onTag} labels={labels} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}

      {data && (
        <div style={{ color: T.muted, fontSize: 12, lineHeight: 1.8 }}>
          <Commissions fees={fees} onSave={saveFees} />
          {all.length > 0 && (
            <><br />Best and worst are the furthest price went for and against a position while it was on, in points per contract from the average entry, from one-minute bars. Open P&amp;L in dollars follows the size actually held, so adds and partial exits count when they happened. A minute's high and low count only when the position was on for all of it; in the minutes it opened and closed, only the fill prices and that minute's close or open count, so a move inside those minutes can be missed. A position opened and closed inside one minute is too short to measure.
              {' '}Bars come from Yahoo Finance on their own: a day is filled in four hours either side of its trades, a missed day is fetched the next time the journal is opened, and a day still running keeps refreshing. Yahoo keeps one-minute bars for about 30 days, so anything older needs a one-minute chart export, added with Add price bars.
              {' '}{nqBars ? `Bars are loaded through ${new Date(nqBars.t1 * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/New_York' })}.` : ''}
              {data.pulled && data.pulled.error ? ` The last fetch from Yahoo did not work (${data.pulled.error}); it is tried again in half an hour.` : ''}</>
          )}
        </div>
      )}
    </div>
  )
}
