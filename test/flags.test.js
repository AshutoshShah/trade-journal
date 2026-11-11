import test from 'node:test';
import assert from 'node:assert/strict';
import { addFlags, excursionStats } from '../web/src/lib.js';

let n = 0;
const pos = (o) => ({
  key: `k${++n}`, date: '2026-11-10', account: 'A', instrument: 'MNQZ6', side: 'long', size: 2, n: n,
  t0: Date.UTC(2026, 10, 10, 15, n * 5), t1: Date.UTC(2026, 10, 10, 15, n * 5 + 2), points: 5, pnl: 20,
  fills: [{ side: 'buy', qty: 2, price: 100 }, { side: 'sell', qty: 2, price: 105 }], ...o,
});

test('flags mark size, sizing up after a loss, and adding while behind', () => {
  n = 0;
  const list = [pos({}), pos({}), pos({}), pos({}), pos({}), pos({ pnl: -50, points: -12.5 }),
    pos({ size: 8, fills: [{ side: 'buy', qty: 4, price: 100 }, { side: 'buy', qty: 4, price: 98 }, { side: 'sell', qty: 8, price: 101 }] })];
  const out = addFlags(list, {});
  const last = out[out.length - 1].flags;
  assert.ok(last.includes('size'), 'more than three times the median size');
  assert.ok(last.includes('sizedUp'), 'larger, within 10 minutes of a loss');
  assert.ok(last.includes('added'), 'an add below the average entry on a long');
  assert.deepEqual(out[0].flags, []);
});

test('the numbers under How I trade are used when set', () => {
  n = 0;
  const list = [pos({ pnl: -400, points: -100 }), pos({ n: 4 })];
  const out = addFlags(list, { risk: '$300', dayStop: '350', maxPositions: '3' });
  assert.ok(out[0].flags.includes('bigLoss'));
  assert.ok(out[1].flags.includes('pastStop'));
  assert.ok(out[1].flags.includes('overCount'));
});

test('excursion summaries skip positions without bars', () => {
  n = 0;
  const s = excursionStats([pos({ best_pts: 10, worst_pts: -3, best_usd: 40 }), pos({})]);
  assert.equal(s.n, 1);
  assert.equal(s.of, 2);
  assert.equal(s.winHeat, -3);
});
