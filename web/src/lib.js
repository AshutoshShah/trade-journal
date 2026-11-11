// Small shared helpers: formatting, dates, and the numbers behind the pages.

import { T, today, getZone } from './theme.js'

export const money = (n) => (n == null ? '' : `${n < 0 ? '-' : '+'}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`)
export const plain$ = (n) => (n == null ? '' : `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`)
export const pts = (n) => (n == null ? '' : `${n > 0 ? '+' : ''}${n.toFixed(1)}`)
export const px = (n) => (n == null ? '' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
export const tone = (n) => (n == null || n === 0 ? T.sub : n > 0 ? T.green : T.red)
export const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0)
export const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

const clockIn = (ms, timeZone, withSec) => new Intl.DateTimeFormat('en-GB', {
  timeZone, hour: '2-digit', minute: '2-digit', ...(withSec ? { second: '2-digit' } : {}), hour12: false,
}).format(new Date(ms))
export const et = (ms, withSec) => clockIn(ms, 'America/New_York', withSec)
export const local = (ms, withSec) => clockIn(ms, getZone(), withSec)

export function hold(sec) {
  if (sec == null) return ''
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  return m < 60 ? `${m}m ${String(sec % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

const utc = (d) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)) }
export const shiftDate = (d, days) => { const x = utc(d); x.setUTCDate(x.getUTCDate() + days); return x.toISOString().slice(0, 10) }
export const weekday = (d) => utc(d).getUTCDay()
export const dayLabel = (d, opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) => utc(d).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' })
export const monthLabel = (ym) => utc(`${ym}-01`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

// The last `n` weekdays ending today (New York date), oldest first.
export function recentWeekdays(n) {
  const out = []
  for (let d = today(); out.length < n; d = shiftDate(d, -1)) { const w = weekday(d); if (w !== 0 && w !== 6) out.unshift(d) }
  return out
}

// ─── Commissions ─────────────────────────────────────────────────
// `fees` is dollars per contract per side, by instrument root. When any is set,
// every position's P&L is shown after commissions and `gross` keeps the original.
export function applyFees(positions, fees) {
  const on = fees && Object.values(fees).some((v) => parseFloat(v) > 0)
  return positions.map((p) => {
    const rate = on ? parseFloat(fees[p.root]) || 0 : 0
    const fee = rate ? Math.round(sum(p.fills, (f) => f.qty) * rate * 100) / 100 : 0
    return { ...p, gross: p.pnl, fee, pnl: p.pnl == null ? null : Math.round((p.pnl - fee) * 100) / 100 }
  })
}

export function groupDays(positions) {
  const m = new Map()
  for (const p of positions) { if (!m.has(p.date)) m.set(p.date, []); m.get(p.date).push(p) }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, list]) => {
    const closed = list.filter((p) => !p.open)
    let run = 0, peak = 0, low = 0
    for (const p of closed) { run += p.pnl; peak = Math.max(peak, run); low = Math.min(low, run) }
    return { date, list, closed, net: run, peak, low, gaveBack: peak - run }
  })
}

// ─── The numbers ─────────────────────────────────────────────────
function streaks(flags) {
  let bestW = 0, bestL = 0, w = 0, l = 0
  for (const f of flags) {
    if (f > 0) { w++; l = 0 } else if (f < 0) { l++; w = 0 } else { w = 0; l = 0 }
    bestW = Math.max(bestW, w); bestL = Math.max(bestL, l)
  }
  return { bestW, bestL, curW: w, curL: l }
}

export function computeStats(positions, days) {
  if (!positions.length) return null
  const ordered = [...positions].sort((a, b) => a.t0 - b.t0)
  const wins = ordered.filter((p) => p.pnl > 0), losses = ordered.filter((p) => p.pnl < 0)
  const grossWin = sum(wins, (p) => p.pnl), grossLoss = -sum(losses, (p) => p.pnl)
  const net = grossWin - grossLoss
  let run = 0, peak = 0, maxDD = 0
  const curve = ordered.map((p, i) => {
    run += p.pnl; peak = Math.max(peak, run); maxDD = Math.max(maxDD, peak - run)
    return { i: i + 1, net: Math.round(run), dd: Math.round(run - peak), date: p.date.slice(5) }
  })
  const dayNets = [...days].reverse().map((d) => d.net)
  const withBars = wins.filter((p) => p.best_pts > 0)
  const st = streaks(ordered.map((p) => p.pnl)), dst = streaks(dayNets)
  return {
    n: ordered.length, days: days.length, net, fees: sum(ordered, (p) => p.fee),
    perDay: ordered.length / days.length,
    winRate: wins.length / ordered.length,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    payoff: wins.length && losses.length ? (grossWin / wins.length) / (grossLoss / losses.length) : null,
    profitFactor: grossLoss ? grossWin / grossLoss : null,
    expectancy: net / ordered.length,
    bestPos: Math.max(...ordered.map((p) => p.pnl)), worstPos: Math.min(...ordered.map((p) => p.pnl)),
    maxDD, curDD: peak - run, curve,
    bestDay: Math.max(...dayNets), worstDay: Math.min(...dayNets),
    avgDay: net / days.length, greenDays: dayNets.filter((x) => x > 0).length,
    medHold: median(ordered.map((p) => p.hold_sec)),
    medHoldWin: median(wins.map((p) => p.hold_sec)), medHoldLoss: median(losses.map((p) => p.hold_sec)),
    streak: st, dayStreak: dst,
    reNet: sum(ordered.filter((p) => p.reentry), (p) => p.pnl), reCount: ordered.filter((p) => p.reentry).length,
    kept: withBars.length ? sum(withBars, (p) => p.points) / sum(withBars, (p) => p.best_pts) : null,
    heat: withBars.length ? median(withBars.map((p) => p.worst_pts)) : null,
    gaveBack: sum(days, (d) => d.gaveBack) / days.length,
  }
}

// What the next position did after a win and after a loss, same day only.
export function afterResult(days) {
  const afterWin = [], afterLoss = []
  for (const d of days) {
    for (let i = 1; i < d.closed.length; i++) {
      const prev = d.closed[i - 1]
      if (prev.pnl > 0) afterWin.push(d.closed[i]); else if (prev.pnl < 0) afterLoss.push(d.closed[i])
    }
  }
  return [{ label: 'After a win', list: afterWin }, { label: 'After a loss', list: afterLoss }]
}

export function byMonth(days) {
  const m = new Map()
  for (const d of days) { const k = d.date.slice(0, 7); if (!m.has(k)) m.set(k, []); m.get(k).push(d) }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([ym, ds]) => {
    const pos = ds.flatMap((d) => d.closed)
    return {
      ym, days: ds.length, positions: pos.length, net: sum(ds, (d) => d.net),
      won: pos.length ? pos.filter((p) => p.pnl > 0).length / pos.length : 0,
      upDays: ds.filter((d) => d.net > 0).length,
      best: Math.max(...ds.map((d) => d.net)), worst: Math.min(...ds.map((d) => d.net)),
    }
  })
}

// Resamples past day results to show the spread of where the next `horizon`
// trading days could land if they looked like the days so far. Seeded, so the
// figures do not jump on every refresh.
export function simulate(dayNets, horizon = 20, runs = 3000) {
  if (dayNets.length < 10) return null
  let seed = 12345
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
  const ends = [], dds = []
  for (let r = 0; r < runs; r++) {
    let run = 0, peak = 0, dd = 0
    for (let i = 0; i < horizon; i++) { run += dayNets[Math.floor(rand() * dayNets.length)]; peak = Math.max(peak, run); dd = Math.max(dd, peak - run) }
    ends.push(run); dds.push(dd)
  }
  ends.sort((a, b) => a - b); dds.sort((a, b) => a - b)
  const q = (a, x) => a[Math.min(a.length - 1, Math.floor(x * a.length))]
  return { horizon, up: ends.filter((x) => x > 0).length / runs, p5: q(ends, 0.05), p50: q(ends, 0.5), p95: q(ends, 0.95), dd50: q(dds, 0.5), dd95: q(dds, 0.95) }
}

// Offered in the Label column on Sessions until Settings saves a list.
export const DEFAULT_LABELS = ['Breakout', 'Failed breakout', 'Pullback', 'Reversal', 'Other']

export const quantile = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))] }

// ─── Flags ───────────────────────────────────────────────────────
// Markers for a second look, worked out from the fills and the bars. They are
// descriptions, not verdicts: a flagged position can be a good trade. The
// numbers in How I trade are used where they are set.
export const FLAGS = [
  { key: 'review', short: 'Review', label: 'Marked for review', help: 'Marked by hand.' },
  { key: 'size', short: 'Large size', label: 'Larger than usual', help: 'Peak size more than three times the usual size: the one under How I trade, or else the median of the 20 positions before it.' },
  { key: 'sizedUp', short: 'Sized up', label: 'Sized up after a loss', help: 'Opened within 10 minutes of a losing position, at a larger peak size than that one.' },
  { key: 'added', short: 'Added behind', label: 'Added while behind', help: 'At least one add at a worse price than the average entry so far.' },
  { key: 'upThenDown', short: 'Up, closed down', label: 'Up first, closed at a loss', help: 'A loss that was 8 points or more in profit on its average entry first.' },
  { key: 'gaveBack', short: 'Gave back', label: 'Kept under a third', help: 'A win that kept less than a third of its best open profit, after being 8 points or more in profit.' },
  { key: 'heat', short: '20 against', label: '20 points against', help: 'Went 20 points or more against its average entry while on.' },
  { key: 'ranOn', short: 'Ran on', label: 'Ran on after the exit', help: 'A win where, in the 15 minutes after the exit, price went on at least twice as far again as the position made, and 15 points or more.' },
  { key: 'cameBack', short: 'Came back', label: 'Came back after the exit', help: 'A loss where, in the 15 minutes after the exit, price went back past the average entry by 10 points or more.' },
  { key: 'bigLoss', short: 'Large loss', label: 'Large loss', help: 'A loss larger than the risk per position under How I trade, or else more than twice the average loss.' },
  { key: 'pastStop', short: 'Past stop', label: 'Past the daily stop', help: 'Opened when the day was already down by the daily stop under How I trade.' },
  { key: 'overCount', short: 'Over count', label: 'Over the day’s count', help: 'Beyond the positions per day under How I trade.' },
]
export const FLAG = Object.fromEntries(FLAGS.map((f) => [f.key, f]))

const amount = (v) => { const x = parseFloat(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(x) && x > 0 ? x : null }

function addedBehind(p) {
  const d = p.side === 'long' ? 1 : -1
  let q = 0, avg = 0
  for (const f of p.fills) {
    if ((f.side === 'buy' ? 1 : -1) !== d) { q -= f.qty; continue }
    if (q > 0 && (f.price - avg) * d < 0) return true
    avg = (avg * q + f.price * f.qty) / (q + f.qty); q += f.qty
  }
  return false
}

// Closed positions, any order. Returns copies, in time order, each with `flags`.
export function addFlags(positions, limits = {}) {
  const usual = amount(limits.size), risk = amount(limits.risk), dayStop = amount(limits.dayStop), maxN = amount(limits.maxPositions)
  const ordered = [...positions].sort((a, b) => a.t0 - b.t0)
  const losses = ordered.filter((p) => p.pnl < 0)
  const avgLoss = losses.length >= 5 ? -sum(losses, (p) => p.pnl) / losses.length : null
  const sizes = [], dayNet = new Map(), last = new Map()
  return ordered.map((p) => {
    const f = []
    if (p.review) f.push('review')
    const base = usual ?? (sizes.length >= 5 ? median(sizes.slice(-20)) : null)
    if (base && p.size > 3 * base) f.push('size')
    const k = `${p.date}|${p.account}|${p.instrument}`, prev = last.get(k)
    if (prev && prev.pnl < 0 && p.t0 - prev.t1 <= 10 * 60000 && p.size > prev.size) f.push('sizedUp')
    if (addedBehind(p)) f.push('added')
    if (p.pnl < 0 && p.best_pts >= 8) f.push('upThenDown')
    if (p.pnl > 0 && p.best_pts >= 8 && p.best_usd > 0 && (p.gross ?? p.pnl) < p.best_usd / 3) f.push('gaveBack')
    if (p.worst_pts != null && p.worst_pts <= -20) f.push('heat')
    if (p.pnl > 0 && p.after_for != null && p.after_for >= Math.max(15, 2 * p.points)) f.push('ranOn')
    if (p.pnl < 0 && p.after_for != null && p.after_for >= -p.points + 10) f.push('cameBack')
    if (p.pnl < 0 && (risk ? -p.pnl > risk : avgLoss && -p.pnl > 2 * avgLoss)) f.push('bigLoss')
    const dn = dayNet.get(p.date) || 0
    if (dayStop && dn <= -dayStop) f.push('pastStop')
    if (maxN && p.n > maxN) f.push('overCount')
    dayNet.set(p.date, dn + p.pnl); last.set(k, p); sizes.push(p.size)
    return { ...p, flags: f }
  })
}

// ─── How far positions moved ─────────────────────────────────────
export const HEAT = [
  { label: 'Under 5 points against', test: (x) => x > -5 },
  { label: '5 to 10 points', test: (x) => x <= -5 && x > -10 },
  { label: '10 to 20 points', test: (x) => x <= -10 && x > -20 },
  { label: '20 points or more', test: (x) => x <= -20 },
]
export const REACH = [
  { label: 'Under 5 points for', test: (x) => x < 5 },
  { label: '5 to 10 points', test: (x) => x >= 5 && x < 10 },
  { label: '10 to 20 points', test: (x) => x >= 10 && x < 20 },
  { label: '20 points or more', test: (x) => x >= 20 },
]

export function excursionStats(positions) {
  const m = positions.filter((p) => p.best_pts != null)
  if (!m.length) return null
  const wins = m.filter((p) => p.pnl > 0), losses = m.filter((p) => p.pnl < 0)
  const after = positions.filter((p) => p.after_for != null)
  const keptOf = wins.filter((p) => p.best_usd > 0)
  return {
    n: m.length, of: positions.length,
    winHeat: median(wins.map((p) => p.worst_pts)), winHeat90: quantile(wins.map((p) => -p.worst_pts), 0.9),
    lossReach: median(losses.map((p) => p.best_pts)), lossesUp: losses.filter((p) => p.best_pts >= 8).length, losses: losses.length,
    lossHeat: median(losses.map((p) => p.worst_pts)),
    kept: keptOf.length ? sum(keptOf, (p) => p.gross ?? p.pnl) / sum(keptOf, (p) => p.best_usd) : null,
    winRanOn: median(after.filter((p) => p.pnl > 0).map((p) => p.after_for)),
    lossCameBack: median(after.filter((p) => p.pnl < 0).map((p) => p.after_for)),
    afterN: after.length,
  }
}
