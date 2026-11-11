// Data layer: thin wrappers over the Worker's JSON API. The sign-in cookie is
// sent with every request; a 401 tells the app to show the sign-in screen.

const API = '/api'

async function api(path, opts = {}) {
  const { method = 'GET', body, form } = opts
  const init = { method, headers: {} }
  if (form) init.body = form
  else if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body) }
  const res = await fetch(API + path, init)
  if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('journal:signed-out'))
  if (!res.ok) {
    let msg
    try { msg = (await res.json()).error } catch { /* not JSON */ }
    throw new Error(msg || `HTTP ${res.status}`)
  }
  const ct = res.headers.get('content-type') || ''
  return ct.includes('application/json') ? res.json() : res.text()
}

const qs = (o) => {
  const p = new URLSearchParams()
  Object.entries(o).forEach(([k, v]) => { if (v) p.set(k, v) })
  const s = p.toString()
  return s ? `?${s}` : ''
}

// ─── Positions, built on the server from the raw fills ───────────
export const getSessions = ({ from, to } = {}) => api(`/sessions${qs({ from, to })}`)
export const tagPosition = (key, setup, note, review) => api('/sessions/tag', { method: 'PUT', body: { key, setup, note, review } })
export const importFills = (body) => api('/sessions/import', { method: 'POST', body })
export const removeDayFills = (date) => api(`/sessions/fills${qs({ date })}`, { method: 'DELETE' })

export async function uploadSessionBars(file, symbol = 'NQ') {
  const res = await fetch(`${API}/sessions/bars${qs({ symbol })}`, {
    method: 'POST', headers: { 'content-type': 'text/csv' }, body: await file.text(),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// ─── Free-text notes for a day ───────────────────────────────────
export const getSessionDay = (date) => api(`/sessions/day${qs({ date })}`)
export const saveSessionDay = (date, { plan, review }) => api(`/sessions/day${qs({ date })}`, { method: 'PUT', body: { plan, review } })

// ─── Sign-in and setup ───────────────────────────────────────────
export const getConfig = () => api('/config')
export const signIn = (password) => api('/auth/login', { method: 'POST', body: { password } })
export const signOut = () => api('/auth/logout', { method: 'POST', body: {} })

// ─── API keys for agents ─────────────────────────────────────────
export const listKeys = () => api('/keys')
export const createKey = (name) => api('/keys', { method: 'POST', body: { name } })
export const revokeKey = (id) => api(`/keys/${id}`, { method: 'DELETE' })

// ─── Settings and the "How I trade" text ─────────────────────────
export const getProfile = () => api('/profile')
export const updateProfile = (updates) => api('/profile', { method: 'PATCH', body: updates })

// ─── Chart screenshots ───────────────────────────────────────────
export const getDailyCharts = (date) => api(`/charts${qs({ date })}`)
export const deleteChart = (id) => api(`/charts/${id}`, { method: 'DELETE' })
export const chartUrl = (path) => `${API}/img/${path.split('/').map(encodeURIComponent).join('/')}`
export function uploadChart(date, file) {
  const form = new FormData()
  form.append('date', date); form.append('file', file)
  return api('/charts', { method: 'POST', form })
}
export const getBars = (symbol, from, to) => api(`/sessions/bars${qs({ symbol, from: String(from), to: String(to) })}`)
