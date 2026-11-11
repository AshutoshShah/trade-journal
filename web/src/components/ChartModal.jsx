import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { T, zoneLabel, zoneOffsetMinutes } from '../theme'
import { getBars } from '../db'
import { money, dayLabel } from '../lib'

// Full-screen chart for a day or a single position: drag to scroll, wheel or
// pinch to zoom, every fill marked. The charting library is loaded only when
// this opens.

const HOURS_AROUND = 4

export default function ChartModal({ positions, title, onClose }) {
  const box = useRef(null)
  const [zone, setZone] = useState('local')
  const [state, setState] = useState('Loading')
  const [tf, setTf] = useState(1)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [onClose])

  useEffect(() => {
    let chart = null, dead = false, ro = null
    const fills = positions.flatMap((p) => p.fills)
    const t0 = Math.min(...fills.map((f) => f.t)), t1 = Math.max(...fills.map((f) => f.t))
    const from = Math.floor(t0 / 1000) - HOURS_AROUND * 3600, to = Math.floor(t1 / 1000) + HOURS_AROUND * 3600
    // The library draws UTC, so times are shifted to the wall clock being shown.
    const shift = zoneOffsetMinutes(t0, zone === 'ET' ? 'America/New_York' : undefined) * 60

    Promise.all([import('lightweight-charts'), getBars(positions[0].root, from, to)]).then(([lw, r]) => {
      if (dead || !box.current) return
      if (!r.bars.length) { setState('No price bars are stored for this day.'); return }
      setState('')
      const step = tf * 60
      const candles = []
      for (const b of r.bars) {
        const k = b[0] - (b[0] % step) + shift
        const c = candles[candles.length - 1]
        if (c && c.time === k) { c.high = Math.max(c.high, b[2]); c.low = Math.min(c.low, b[3]); c.close = b[4] } else candles.push({ time: k, open: b[1], high: b[2], low: b[3], close: b[4] })
      }
      chart = lw.createChart(box.current, {
        width: box.current.clientWidth, height: box.current.clientHeight,
        layout: { background: { color: T.bg }, textColor: T.sub, fontFamily: T.mono, fontSize: 12 },
        grid: { vertLines: { color: '#17171a' }, horzLines: { color: '#17171a' } },
        rightPriceScale: { borderColor: T.border },
        timeScale: { borderColor: T.border, timeVisible: true, secondsVisible: false, rightOffset: 4 },
        crosshair: { mode: lw.CrosshairMode.Normal },
        handleScroll: true, handleScale: true,
      })
      const series = chart.addCandlestickSeries({
        upColor: T.green, downColor: T.red, borderUpColor: T.green, borderDownColor: T.red, wickUpColor: T.green, wickDownColor: T.red,
        priceFormat: { type: 'price', precision: 2, minMove: 0.25 },
      })
      series.setData(candles)
      const markers = fills.map((f) => {
        const buy = f.side === 'buy'
        const sec = Math.floor(f.t / 1000)
        return {
          time: sec - (sec % step) + shift, position: buy ? 'belowBar' : 'aboveBar', color: buy ? T.green : T.red,
          shape: buy ? 'arrowUp' : 'arrowDown', size: 1.4,
          // Prices on every arrow only when there are few enough to read.
          text: fills.length <= 8 ? `${f.qty} @ ${f.price.toFixed(2)}` : '',
        }
      }).sort((a, b) => a.time - b.time)
      series.setMarkers(markers)
      // Open on the trades with some room either side; the rest is a drag away.
      const pad = Math.max(20 * 60, (t1 - t0) / 1000 * 0.25)
      chart.timeScale().setVisibleRange({ from: Math.floor(t0 / 1000) - pad + shift, to: Math.floor(t1 / 1000) + pad + shift })
      ro = new ResizeObserver(() => { if (box.current && chart) chart.resize(box.current.clientWidth, box.current.clientHeight) })
      ro.observe(box.current)
    }).catch((e) => { if (!dead) setState(e.message) })

    return () => { dead = true; if (ro) ro.disconnect(); if (chart) chart.remove() }
  }, [positions, zone, tf])

  const net = positions.filter((p) => !p.open).reduce((s, p) => s + (p.pnl || 0), 0)
  const chip = (active) => ({
    background: active ? `${T.accent}18` : T.card2, color: active ? T.accent : T.sub, border: `1px solid ${active ? T.accent : T.border}`,
    borderRadius: 6, padding: '5px 10px', fontFamily: T.sans, fontSize: 12, fontWeight: 600, cursor: 'pointer', minHeight: 32,
  })

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: T.bg, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 14px', borderBottom: `1px solid ${T.border}`, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{title || dayLabel(positions[0].date)}</div>
          <div style={{ fontSize: 12, color: T.muted, fontFamily: T.mono }}>
            {positions.length} {positions.length === 1 ? 'position' : 'positions'}, <span style={{ color: net >= 0 ? T.green : T.red }}>{money(net)}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {[1, 5, 15].map((m) => <button key={m} onClick={() => setTf(m)} style={chip(tf === m)}>{m}m</button>)}
          <span style={{ width: 6 }} />
          {[['local', zoneLabel()], ['ET', 'ET']].map(([z, l]) => <button key={z} onClick={() => setZone(z)} style={chip(zone === z)}>{l}</button>)}
          <span style={{ width: 6 }} />
          <button onClick={onClose} style={{ ...chip(false), color: T.text }}>Close</button>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div ref={box} style={{ position: 'absolute', inset: 0 }} />
        {state && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, fontSize: 14 }}>{state}</div>}
      </div>
      <div style={{ padding: '6px 14px calc(6px + env(safe-area-inset-bottom, 0px))', borderTop: `1px solid ${T.border}`, fontSize: 11, color: T.muted }}>
        Drag to scroll, pinch or use the wheel to zoom. Green arrows are buys, red are sells.
      </div>
    </div>,
    document.body,
  )
}
