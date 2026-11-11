// Time zones. Everything is stored as a UTC instant. Trading days and
// time-of-day buckets use New York time, where the US index futures session is
// defined. The journal's own time zone (a setting) is used to read times sent
// without an offset and to show times on the pages.

const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short', hour12: false,
    }));
  }
  return fmtCache.get(tz);
}

// Wall-clock parts of a UTC instant in `tz`, daylight saving included.
export function zoneParts(instant, tz) {
  const p = {};
  for (const part of fmt(tz).formatToParts(instant)) p[part.type] = part.value;
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0; // some engines emit '24' for midnight
  return {
    year: parseInt(p.year, 10),
    month: parseInt(p.month, 10),
    day: parseInt(p.day, 10),
    hour,
    minute: parseInt(p.minute, 10),
    second: parseInt(p.second, 10),
    weekday: p.weekday,
  };
}

export const etParts = (instant) => zoneParts(instant, 'America/New_York');

export function isZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { fmt(tz); return true; } catch { return false; }
}

// Minutes `tz` is ahead of UTC at a given instant.
export function offsetMinutes(utcMs, tz) {
  const p = zoneParts(new Date(utcMs), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

// The UTC instant of a wall-clock time in `tz`. Two passes settle the offset
// around a daylight saving change. A wall time that does not exist (inside the
// spring-forward gap) comes out an hour later, as clocks would show it.
export function zonedToUtc(y, mo, d, h, mi, s, ms, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const first = wall - offsetMinutes(wall, tz) * 60000;
  const second = wall - offsetMinutes(first, tz) * 60000;
  const shows = (utc) => {
    const p = zoneParts(new Date(utc), tz);
    return p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi && p.second === s;
  };
  if (shows(second)) return second;
  if (shows(first)) return first;
  return Math.max(first, second);   // inside the gap: the later reading
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

// "YYYY-MM-DD HH:MM:SS[.mmm]" in `tz`.
export function wallIn(utcMs, tz, withMs) {
  const e = zoneParts(new Date(utcMs), tz);
  const base = `${e.year}-${pad(e.month)}-${pad(e.day)} ${pad(e.hour)}:${pad(e.minute)}:${pad(e.second)}`;
  return withMs ? `${base}.${pad(((utcMs % 1000) + 1000) % 1000, 3)}` : base;
}

// ── Reading a sent time ──────────────────────────────────────────────────────

const FULL = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*([AaPp]\.?[Mm]\.?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;
const TIME_ONLY = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*([AaPp]\.?[Mm]\.?)?$/;

// Parses a wall time ("2026-10-05 19:10:23", "...T19:10:23", "7:10:23 PM", with
// optional fractional seconds) in `zone`. An explicit offset wins if one is given.
export function parseTime(raw, day, zone) {
  const s = String(raw ?? '').trim();
  if (!s) return { error: 'missing time' };
  let y, mo, d, h, mi, sec, frac, ampm, off;
  let timeOnly = false;
  let m = FULL.exec(s);
  if (m) {
    [, y, mo, d, h, mi, sec, frac, ampm, off] = m;
  } else if ((m = TIME_ONLY.exec(s)) && day) {
    [, h, mi, sec, frac, ampm] = m;
    [y, mo, d] = day.split('-');
    timeOnly = true;
  } else {
    return { error: `unrecognised time ${JSON.stringify(s)}; send "YYYY-MM-DD HH:MM:SS"` };
  }
  y = +y; mo = +mo; d = +d; h = +h; mi = +mi;
  sec = sec == null ? 0 : +sec;
  const ms = frac ? +String(frac).slice(0, 3).padEnd(3, '0') : 0;
  if (ampm) {
    if (h < 1 || h > 12) return { error: `bad 12-hour time ${JSON.stringify(s)}` };
    const pm = /^p/i.test(ampm);
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  // Date.UTC silently rolls impossible values over (Feb 30 -> Mar 2); refuse them.
  const check = new Date(Date.UTC(y, mo - 1, d, h, mi, sec, ms));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d
      || check.getUTCHours() !== h || check.getUTCMinutes() !== mi || check.getUTCSeconds() !== sec) {
    return { error: `impossible date/time ${JSON.stringify(s)}` };
  }
  let utcMs;
  if (off) {
    const offMin = off.toUpperCase() === 'Z' ? 0 : (off[0] === '-' ? -1 : 1) * (+off.slice(1, 3) * 60 + +off.slice(-2));
    utcMs = Date.UTC(y, mo - 1, d, h, mi, sec, ms) - offMin * 60000;
  } else {
    utcMs = zonedToUtc(y, mo, d, h, mi, sec, ms, zone);
  }
  return { utcMs, hadMs: !!frac, timeOnly };
}
