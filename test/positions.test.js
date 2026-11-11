import test from 'node:test';
import assert from 'node:assert/strict';
import { groupFills, excursion, rootOf } from '../worker/positions.js';

const T0 = Date.UTC(2026, 10, 10, 15, 0, 0);       // 10:00 ET
const at = (sec) => T0 + sec * 1000;
const fill = (sec, side, qty, price) => ({ ms: at(sec), side, qty, price, batch: 1 });

test('rootOf reads contract codes', () => {
  assert.equal(rootOf('MNQZ6'), 'MNQ');
  assert.equal(rootOf('/NQH7'), 'NQ');
  assert.equal(rootOf('mesz6'), 'MES');
  assert.equal(rootOf('CLZ6'), null);
});

test('fills group flat to flat, with scale-ins and scale-outs in one position', () => {
  const g = groupFills([
    fill(0, 'buy', 2, 100), fill(30, 'buy', 1, 98), fill(90, 'sell', 2, 105), fill(120, 'sell', 1, 107),
    fill(200, 'sell', 1, 110), fill(260, 'buy', 1, 104),
  ]);
  assert.equal(g.length, 2);
  assert.equal(g[0].dir, 1);
  assert.equal(g[0].peak, 3);
  assert.equal(g[0].clipsIn, 2);
  assert.equal(g[0].clipsOut, 2);
  assert.equal(g[1].dir, -1);
  assert.ok(!g[0].open && !g[1].open);
});

test('a fill through zero closes one position and opens the next', () => {
  const g = groupFills([fill(0, 'buy', 2, 100), fill(60, 'sell', 3, 110), fill(120, 'buy', 1, 105)]);
  assert.equal(g.length, 2);
  assert.equal(g[0].outQty, 2);
  assert.equal(g[1].dir, -1);
  assert.equal(g[1].inQty, 1);
});

test('a position still on at the end is marked open', () => {
  const g = groupFills([fill(0, 'buy', 1, 100)]);
  assert.equal(g[0].open, true);
});

// Bars: [high, low, open, close] keyed by minute start (UTC seconds).
const minute = (m) => T0 / 1000 + m * 60;
function series(rows) { return new Map(rows.map(([m, h, l, o, c]) => [minute(m), [h, l, o, c]])); }
function position(fills, side, entry, points, pnl) {
  return { root: 'MNQ', side, entry, points, pnl, t0: fills[0].t, t1: fills[fills.length - 1].t, fills };
}

test('excursions use whole minutes only while the position was on all of them', () => {
  // Long 1 MNQ at 100 in minute 0, out at 110 in minute 3.
  const fills = [{ t: at(20), side: 'buy', qty: 1, price: 100 }, { t: at(200), side: 'sell', qty: 1, price: 110 }];
  const p = position(fills, 'long', 100, 10, 20);
  const bars = series([
    [0, 130, 70, 99, 101],    // entry minute: its extremes must not count, only the close
    [1, 108, 95, 101, 104],   // on all minute
    [2, 112, 103, 104, 109],  // on all minute
    [3, 140, 60, 109, 111],   // exit minute: only the open and the fill count
  ]);
  excursion(p, bars);
  assert.equal(p.best_pts, 12);
  assert.equal(p.worst_pts, -5);
  assert.equal(p.best_usd, 24);
  assert.equal(p.worst_usd, -10);
});

test('dollar excursions follow the size held at the time', () => {
  // 1 lot at 100, add 3 at 90 in minute 2 (average 92.5), out at 95.
  const fills = [
    { t: at(10), side: 'buy', qty: 1, price: 100 },
    { t: at(150), side: 'buy', qty: 3, price: 90 },
    { t: at(250), side: 'sell', qty: 4, price: 95 },
  ];
  const p = position(fills, 'long', 92.5, 2.5, 20);
  const bars = series([[0, 100, 100, 100, 100], [1, 100, 92, 100, 93], [2, 93, 88, 93, 91], [3, 96, 91, 91, 95], [4, 95, 95, 95, 95]]);
  excursion(p, bars);
  // Worst: 4 lots at 88 against an average of 92.5 = -4.5 * 4 * $2.
  assert.equal(p.worst_usd, -36);
});

test('a position opened and closed inside one minute is left unmeasured', () => {
  const fills = [{ t: at(5), side: 'buy', qty: 1, price: 100 }, { t: at(40), side: 'sell', qty: 1, price: 101 }];
  const p = position(fills, 'long', 100, 1, 2);
  excursion(p, series([[0, 120, 80, 100, 100]]));
  assert.equal(p.best_pts, undefined);
});

test('after the exit: further and back, once most of the 15 minutes are stored', () => {
  const fills = [{ t: at(5), side: 'sell', qty: 1, price: 100 }, { t: at(70), side: 'buy', qty: 1, price: 95 }];
  const p = position(fills, 'short', 100, 5, 10);
  const rows = [[0, 100, 100, 100, 100], [1, 100, 95, 100, 95]];
  for (let m = 2; m <= 16; m++) rows.push([m, 97, m === 9 ? 80 : 94, 95, 95]);
  excursion(p, series(rows));
  assert.equal(p.after_for, 15);
  assert.equal(p.after_against, 2);
});
