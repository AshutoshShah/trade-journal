import test from 'node:test';
import assert from 'node:assert/strict';
import { zonedToUtc, wallIn, parseTime, isZone, offsetMinutes } from '../worker/time.js';

const iso = (ms) => new Date(ms).toISOString();

test('a fixed-offset zone converts both ways', () => {
  const utc = zonedToUtc(2026, 3, 16, 19, 45, 10, 0, 'Asia/Kolkata');
  assert.equal(iso(utc), '2026-03-16T14:15:10.000Z');
  assert.equal(wallIn(utc, 'Asia/Kolkata'), '2026-03-16 19:45:10');
  assert.equal(wallIn(utc, 'America/New_York'), '2026-03-16 10:15:10');
});

test('New York daylight saving is followed on both sides of the change', () => {
  // 2026: DST ends Sunday 1 November.
  assert.equal(iso(zonedToUtc(2026, 10, 30, 9, 30, 0, 0, 'America/New_York')), '2026-10-30T13:30:00.000Z');
  assert.equal(iso(zonedToUtc(2026, 11, 2, 9, 30, 0, 0, 'America/New_York')), '2026-11-02T14:30:00.000Z');
  assert.equal(offsetMinutes(Date.UTC(2026, 6, 1), 'America/New_York'), -240);
  assert.equal(offsetMinutes(Date.UTC(2026, 11, 1), 'America/New_York'), -300);
});

test('a time in the spring-forward gap comes out an hour later', () => {
  // 8 March 2026, 02:30 does not exist in New York.
  assert.equal(wallIn(zonedToUtc(2026, 3, 8, 2, 30, 0, 0, 'America/New_York'), 'America/New_York'), '2026-03-08 03:30:00');
});

test('parseTime reads wall times in the given zone, and honours an explicit offset', () => {
  assert.equal(iso(parseTime('2026-07-15 08:31:00', null, 'America/Chicago').utcMs), '2026-07-15T13:31:00.000Z');
  assert.equal(iso(parseTime('2026-07-15T08:31:00-05:00', null, 'Asia/Tokyo').utcMs), '2026-07-15T13:31:00.000Z');
  assert.equal(iso(parseTime('2026-07-15 13:31:00Z', null, 'Asia/Tokyo').utcMs), '2026-07-15T13:31:00.000Z');
  assert.equal(iso(parseTime('2026-07-15 8:31:00 PM', null, 'UTC').utcMs), '2026-07-15T20:31:00.000Z');
  const t = parseTime('10:05:01', '2026-07-15', 'Europe/London');
  assert.equal(t.timeOnly, true);
  assert.equal(iso(t.utcMs), '2026-07-15T09:05:01.000Z');
  assert.equal(parseTime('2026-07-15 10:05:01.250', null, 'UTC').hadMs, true);
});

test('parseTime refuses impossible and unreadable times', () => {
  assert.match(parseTime('2026-02-30 10:00:00', null, 'UTC').error, /impossible/);
  assert.match(parseTime('yesterday', null, 'UTC').error, /unrecognised/);
  assert.match(parseTime('', null, 'UTC').error, /missing/);
  assert.match(parseTime('13:00 PM', '2026-01-01', 'UTC').error, /12-hour/);
});

test('isZone accepts IANA names only', () => {
  assert.equal(isZone('Europe/London'), true);
  assert.equal(isZone('Mars/Base'), false);
  assert.equal(isZone(''), false);
  assert.equal(isZone(undefined), false);
});
