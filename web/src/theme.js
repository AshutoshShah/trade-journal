export const T = {
  // ── Backgrounds — true black, subtly stepped surfaces ──
  bg:     '#000000',   // page base — true black
  card:   '#101012',   // cards
  card2:  '#17171a',   // nested
  card3:  '#232326',   // hover / active
  border:      '#2b2b2f',   // visible borders
  borderLight: '#404040',   // highlighted borders

  // ── Accent — champagne gold ──────────────────────────────────────
  accent:    '#ccba83',
  accentDim: '#a89460',
  accentBg:  'rgba(204,186,131,0.12)',

  // ── Semantic — tuned to sit calmly beside the gold on black ──────
  green:  '#46c98a',
  red:    '#ef5f5f',
  yellow: '#e3b341',
  orange: '#d98e4b',
  blue:   '#6e9be0',
  purple: '#a98bd6',
  cyan:   '#4fb6c4',

  // ── Text — near-white → zinc hierarchy ───────────────────────────
  text:   '#ecedee',   // primary — near-white
  sub:    '#a1a1aa',   // secondary — zinc, clearly readable
  muted:  '#71717a',   // tertiary — muted but legible
  label:  '#52525b',   // labels
  dim:    '#52525b',   // alias

  focusBorder: '#ccba83',
  focusBg:     '#000000',

  sans: "'Sora', system-ui, sans-serif",
  mono: "'JetBrains Mono', 'Courier New', monospace",
}

export const TRADING_TIME_ZONE = 'America/New_York'

// Today's trading date in New York, YYYY-MM-DD.
export const today = (date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TRADING_TIME_ZONE }).format(date)

// ─── The journal's own time zone ─────────────────────────────────
// Times on the pages are shown in this zone. It starts as the browser's own
// and is replaced by the one saved in Settings once the profile has loaded.
export const browserZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}
let zone = browserZone()
export const getZone = () => zone
export function setZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); zone = tz } catch { /* unknown zone: keep the current one */ }
}

// A short name for the zone, such as "EST", "GMT+1" or "IST".
export function zoneLabel(at = new Date()) {
  if (zone === 'Asia/Kolkata' || zone === 'Asia/Calcutta') return 'IST'
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(at)
    return (p.find((x) => x.type === 'timeZoneName') || {}).value || zone
  } catch { return zone }
}

// The zone's UTC offset in minutes at an instant.
export function zoneOffsetMinutes(ms, tz = zone) {
  const p = {}
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(ms))) p[part.type] = part.value
  let hh = parseInt(p.hour, 10); if (hh === 24) hh = 0
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, hh, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / 60000)
}

// The time in the journal's zone now, as '7:10 PM'.
export function nowLocal12() {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date())
}
