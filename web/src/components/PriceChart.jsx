import { useState, useEffect, useRef } from 'react'
import { T, zoneLabel } from '../theme'
import { getBars } from '../db'
import { local } from '../lib'
import ChartModal from './ChartModal'

// One-minute candles for a window, with every fill marked where it happened:
// buys as green triangles under the price, sells as red triangles over it.
// Drawn at the real pixel width of its container, so text stays readable on a
// phone. Click or tap opens the full-screen chart, which scrolls and zooms.
// Draws nothing when no bars are stored for the window.

export default function PriceChart({ positions, padMin = 20, title }) {
  const wrap = useRef(null)
  const [bars, setBars] = useState(null)
  const [W, setW] = useState(0)
  const [open, setOpen] = useState(false)
  const fills = positions.flatMap((p) => p.fills)
  const t0 = Math.min(...fills.map((f) => f.t)), t1 = Math.max(...fills.map((f) => f.t))
  const from = Math.floor(t0 / 60000) * 60 - padMin * 60, to = Math.floor(t1 / 60000) * 60 + padMin * 60
  const root = positions[0].root

  useEffect(() => {
    let dead = false
    setBars(null)
    getBars(root, from, to).then((r) => { if (!dead) setBars(r.bars) }).catch(() => { if (!dead) setBars([]) })
    return () => { dead = true }
  }, [root, from, to])

  useEffect(() => {
    if (!wrap.current) return undefined
    const measure = () => { if (wrap.current) setW(Math.round(wrap.current.clientWidth)) }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(wrap.current)
    return () => ro.disconnect()
  }, [bars])

  if (!bars || !bars.length) return null

  const narrow = W > 0 && W < 520
  const H = narrow ? Math.round(Math.max(220, W * 0.72)) : Math.round(Math.min(340, Math.max(230, W * 0.3)))
  const padL = 4, padR = narrow ? 44 : 56, padT = 12, padB = 22
  const plotW = Math.max(50, W - padL - padR)

  // Aim for candles at least ~3px wide; merge minutes when the window is long.
  const maxCandles = Math.max(30, Math.floor(plotW / 3.2))
  const step = [1, 2, 3, 5, 10, 15, 30].find((m) => bars.length / m <= maxCandles) || 30
  const candles = []
  for (const b of bars) {
    const k = b[0] - (b[0] % (step * 60))
    const c = candles[candles.length - 1]
    if (c && c.t === k) { c.h = Math.max(c.h, b[2]); c.l = Math.min(c.l, b[3]); c.c = b[4] } else candles.push({ t: k, o: b[1], h: b[2], l: b[3], c: b[4] })
  }

  const lo = Math.min(...candles.map((c) => c.l), ...fills.map((f) => f.price))
  const hi = Math.max(...candles.map((c) => c.h), ...fills.map((f) => f.price))
  const span = hi - lo || 1
  const y = (p) => padT + (1 - (p - (lo - span * 0.07)) / (span * 1.14)) * (H - padT - padB)
  const tMin = candles[0].t, tMax = candles[candles.length - 1].t + step * 60
  const x = (sec) => padL + ((sec - tMin) / (tMax - tMin)) * plotW
  const cw = Math.max(1.2, (plotW / candles.length) * 0.68)
  const ticks = (narrow ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map((f) => lo + span * f)
  const nT = narrow ? 3 : 5
  const times = Array.from({ length: nT }, (_, i) => tMin + ((tMax - tMin) * i) / (nT - 1))
  const mark = narrow ? 5 : 6

  return (
    <div ref={wrap} style={{ width: '100%' }}>
      {W > 0 && (
        <button onClick={() => setOpen(true)} aria-label="Open the full-screen chart" style={{ display: 'block', width: '100%', padding: 0, border: 'none', background: 'transparent', cursor: 'zoom-in', minHeight: 0 }}>
          <svg width={W} height={H} style={{ display: 'block' }} role="img" aria-label="Price chart with fills marked">
            {ticks.map((p, i) => (
              <g key={i}>
                <line x1={padL} x2={W - padR} y1={y(p)} y2={y(p)} stroke={T.border} strokeWidth="1" />
                <text x={W - padR + 5} y={y(p) + 4} fill={T.muted} fontSize="11" fontFamily={T.mono}>{p.toFixed(0)}</text>
              </g>
            ))}
            {times.map((s, i) => (
              <text key={i} x={x(s)} y={H - 6} fill={T.muted} fontSize="11" fontFamily={T.mono} textAnchor={i === 0 ? 'start' : i === nT - 1 ? 'end' : 'middle'}>{local(s * 1000)}</text>
            ))}
            {positions.filter((p) => !p.open).map((p) => (
              <rect key={p.key} x={x(p.t0 / 1000)} width={Math.max(2, x(p.t1 / 1000) - x(p.t0 / 1000))} y={padT} height={H - padT - padB}
                fill={p.pnl >= 0 ? T.green : T.red} opacity="0.08" />
            ))}
            {candles.map((c) => {
              const col = c.c >= c.o ? T.green : T.red, cx = x(c.t + (step * 60) / 2)
              return (
                <g key={c.t}>
                  <line x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth="1" opacity="0.85" />
                  <rect x={cx - cw / 2} width={cw} y={y(Math.max(c.o, c.c))} height={Math.max(1, Math.abs(y(c.o) - y(c.c)))} fill={col} opacity="0.85" />
                </g>
              )
            })}
            {fills.map((f, i) => {
              const fx = x(f.t / 1000), fy = y(f.price), buy = f.side === 'buy'
              const d = buy ? `M${fx},${fy + 2} l-${mark},${mark * 1.8} l${mark * 2},0 z` : `M${fx},${fy - 2} l-${mark},-${mark * 1.8} l${mark * 2},0 z`
              return <path key={i} d={d} fill={buy ? T.green : T.red} stroke="#000" strokeWidth="1" />
            })}
          </svg>
        </button>
      )}
      <div style={{ fontSize: 11, color: T.muted, marginTop: 4, lineHeight: 1.5 }}>
        Times in {zoneLabel()}, {step === 1 ? 'one-minute' : `${step}-minute`} candles. Green triangles are buys, red are sells. {narrow ? 'Tap' : 'Click'} the chart to open it full screen, where it scrolls and zooms.
      </div>
      {open && <ChartModal positions={positions} title={title} onClose={() => setOpen(false)} />}
    </div>
  )
}
