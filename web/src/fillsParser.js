// Turns pasted platform text into fills for the journal.
//
// Two shapes are understood:
//   1. A round-trip trade table, one row per matched buy and sell:
//        SYMBOL ACCOUNT QTY BUYPRICE BUYTIME DURATION SELLTIME SELLPRICE P&L
//        MNQZ6 ACCOUNT1 2 27775.75 11/10/2026 8:18:59 PM 1min 12sec 11/10/2026 8:20:11 PM 27821.75 $184.00
//      Each row becomes one buy fill and one sell fill.
//   2. One fill per line: time, side, quantity, price[, instrument]
//        2026-11-10 19:06:36, buy, 2, 27763.75, MNQZ6
//
// Times are sent as written, without an offset; the caller sends the time zone
// they are in with the day, and the server converts them (daylight saving
// included).

const pad = (n) => String(n).padStart(2, '0')
const num = (s) => parseFloat(String(s).replace(/[$,]/g, ''))

// "11/10/2026 8:18:59 PM" (month first) or "2026-11-10 20:18:59" -> { date, time }
function stamp(s) {
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?$/i.exec(s.trim())
  if (m) {
    let h = +m[4]
    if (m[7]) { const pm = /p/i.test(m[7]); if (pm && h !== 12) h += 12; if (!pm && h === 12) h = 0 }
    return { date: `${m[3]}-${pad(m[1])}-${pad(m[2])}`, time: `${pad(h)}:${m[5]}:${m[6] || '00'}` }
  }
  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim())
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${pad(m[4])}:${m[5]}:${m[6] || '00'}` }
  return null
}

const DT = String.raw`(\d{1,2}\/\d{1,2}\/\d{4}[ ,]+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?|\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?)`
const ROUND_TRIP = new RegExp(String.raw`^(\S+)\s+(\S+)\s+(\d+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)\s+${DT}\s+.*?${DT}\s+([\d,]+(?:\.\d+)?)`, 'i')
const ONE_FILL = new RegExp(String.raw`^${DT}\s+(buy|sell|b|s|bot|sld|bought|sold)\s+(\d+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)(?:\s+(\S+))?`, 'i')

export function parseFills(text) {
  const fills = []
  const skipped = []
  let account = ''
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\t/g, '  ').replace(/\s*[,;|]\s*(?=\S)/g, '  ').trim()).filter(Boolean)
  for (const line of lines) {
    let m = ROUND_TRIP.exec(line)
    if (m) {
      const [, symbol, acct, qty, buyPx, buyAt, sellAt, sellPx] = m
      const b = stamp(buyAt), s = stamp(sellAt)
      if (b && s) {
        account = account || acct
        fills.push({ ...b, side: 'buy', qty: num(qty), price: num(buyPx), instrument: symbol })
        fills.push({ ...s, side: 'sell', qty: num(qty), price: num(sellPx), instrument: symbol })
        continue
      }
    }
    m = ONE_FILL.exec(line)
    if (m) {
      const at = stamp(m[1])
      if (at) {
        fills.push({ ...at, side: /^(b|buy|bot|bought)$/i.test(m[2]) ? 'buy' : 'sell', qty: num(m[3]), price: num(m[4]), instrument: m[5] || 'MNQ' })
        continue
      }
    }
    if (!/price|symbol|account|qty|time/i.test(line) || /\d{4}/.test(line)) skipped.push(line)
  }
  fills.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
  const out = fills.map((f) => ({
    time: `${f.date} ${f.time}`, side: f.side, qty: f.qty, price: f.price, instrument: f.instrument,
  }))
  return { fills: out, account, skipped, firstDate: fills.length ? fills[0].date : null }
}
