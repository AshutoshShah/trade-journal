// Positions from fills, and how far each one moved. Pure functions with no
// database access, so they can be tested on their own (test/positions.test.js).

export const MULT = { MNQ: 2, NQ: 20, MES: 5, ES: 50 };
export const BAR_ROOT = { MNQ: 'NQ', NQ: 'NQ', MES: 'ES', ES: 'ES' };   // micros share the mini's prices

// MNQZ6, NQH7, "MNQ1!", "/MNQ" -> MNQ
export function rootOf(instrument) {
  const m = /^\/?(MNQ|NQ|MES|ES)/i.exec(String(instrument || '').trim());
  return m ? m[1].toUpperCase() : null;
}

export const r2 = (v) => Math.round(v * 100) / 100;


// Group one account+instrument's fills, already in time order, into flat-to-flat
// positions. A fill that takes the position through zero is split: the part that
// closes belongs to the old position, the rest opens a new one.
export function groupFills(fills) {
  const done = [];
  let cur = null;
  const open = (f, qty) => {
    cur = { dir: f.side === 'buy' ? 1 : -1, t0: f.ms, t1: f.ms, batch: f.batch, net: 0, peak: 0,
            inQty: 0, inCost: 0, outQty: 0, outCost: 0, clipsIn: 0, clipsOut: 0, fills: [] };
    add(f, qty);
  };
  const add = (f, qty) => {
    const s = f.side === 'buy' ? 1 : -1;
    cur.fills.push({ t: f.ms, side: f.side, qty, price: f.price, batch: f.batch });
    cur.t1 = f.ms;
    if (s === cur.dir) { cur.inQty += qty; cur.inCost += qty * f.price; cur.clipsIn++; }
    else { cur.outQty += qty; cur.outCost += qty * f.price; cur.clipsOut++; }
    cur.net += s * qty;
    cur.peak = Math.max(cur.peak, Math.abs(cur.net));
  };
  for (const f of fills) {
    if (!f.side || !f.qty || f.price == null || f.ms == null) continue;
    let qty = f.qty;
    if (!cur) { open(f, qty); continue; }
    const s = f.side === 'buy' ? 1 : -1;
    if (s !== cur.dir && qty > Math.abs(cur.net) + 1e-9) {
      const closing = Math.abs(cur.net);
      add(f, closing);
      done.push(cur); cur = null;
      open(f, qty - closing);
      continue;
    }
    add(f, qty);
    if (Math.abs(cur.net) < 1e-9) { done.push(cur); cur = null; }
  }
  if (cur) { cur.open = true; done.push(cur); }
  return done;
}

// How far each position went for and against, from the one-minute bars.
//
// best_pts / worst_pts: the furthest price went from the average entry, in
// points per contract.
// best_usd / worst_usd: the highest and lowest open P&L in dollars while the
// position was on, booked exits included, so a position that scaled in is
// measured at the size it had at the time.
// after_for / after_against: how far price went past the final exit in the
// position's direction, and back against it, in the 15 minutes after.
//
// A one-minute bar does not say whether its high came before or after a fill
// inside it. So a minute's high and low count only when the position was on for
// the whole minute. In the minute it opened, only the fill prices and that
// minute's close count; in the minute it closed, that minute's open and the fill
// prices. A move inside those two minutes can be missed, but a 30-second scalp
// in a 60-point minute is not credited with the whole minute. A position opened
// and closed inside one minute is too short to measure and gets no figures.
export const AFTER_SEC = 15 * 60;

export function excursion(p, series) {
  const mult = MULT[p.root];
  const d = p.side === 'long' ? 1 : -1;
  const m0 = Math.floor(p.t0 / 60000) * 60, m1 = Math.floor(p.t1 / 60000) * 60;
  const fills = p.fills;
  const last = fills[fills.length - 1].price;

  if (m1 > m0 && series) {
    let hi = -Infinity, lo = Infinity, maxOpen = 0, minOpen = 0, seen = 0;
    let q = 0, avg = 0, real = 0, fi = 0;
    const at = (price, st = { q, avg, real }) => {
      hi = Math.max(hi, price); lo = Math.min(lo, price);
      const v = st.real + (price - st.avg) * d * st.q * mult;
      maxOpen = Math.max(maxOpen, v); minOpen = Math.min(minOpen, v);
    };
    for (let ts = m0; ts <= m1; ts += 60) {
      const bar = series.get(ts);                       // [high, low, open, close]
      const before = { q, avg, real };
      if (bar) seen++;
      if (bar && q) at(bar[2]);                          // on at the open
      while (fi < fills.length && fills[fi].t < (ts + 60) * 1000) {
        const f = fills[fi++];
        if ((f.side === 'buy' ? 1 : -1) === d) { avg = (avg * q + f.price * f.qty) / (q + f.qty); q += f.qty; }
        else { real += (f.price - avg) * d * f.qty * mult; q -= f.qty; }
        if (q) at(f.price);
        else { maxOpen = Math.max(maxOpen, real); minOpen = Math.min(minOpen, real); }
      }
      if (!bar || !q) continue;
      at(bar[3]);                                        // on at the close
      if (before.q) {
        // On for the whole minute: its high and low count, at the size held
        // before and after any fills inside it.
        for (const price of [bar[0], bar[1]]) { at(price, before); at(price); }
      }
    }
    if (seen) {
      const best = d === 1 ? hi - p.entry : p.entry - lo;
      const worst = d === 1 ? lo - p.entry : p.entry - hi;
      p.best_pts = r2(Math.max(best, p.points ?? best, 0));
      p.worst_pts = r2(Math.min(worst, p.points ?? worst, 0));
      p.best_usd = r2(Math.max(maxOpen, p.pnl ?? maxOpen));
      p.worst_usd = r2(Math.min(minOpen, p.pnl ?? minOpen));
    }
  }

  // After the exit: the minutes after the exit minute, if most of them are stored.
  if (!series) return;
  let aHi = -Infinity, aLo = Infinity, n = 0;
  for (let ts = m1 + 60; ts <= m1 + AFTER_SEC; ts += 60) {
    const bar = series.get(ts);
    if (!bar) continue;
    n++; aHi = Math.max(aHi, bar[0]); aLo = Math.min(aLo, bar[1]);
  }
  if (n >= 10) {
    p.after_for = r2(Math.max(0, d === 1 ? aHi - last : last - aLo));
    p.after_against = r2(Math.max(0, d === 1 ? last - aLo : aHi - last));
  }
}
