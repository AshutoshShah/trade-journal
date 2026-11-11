import { lazy, Suspense, useState, useEffect, useCallback } from 'react'
import { today, T, nowLocal12, zoneLabel, setZone, browserZone } from './theme'
import { getSessions, getConfig, getProfile, updateProfile } from './db'
import SignIn from './components/SignIn'
import { useMobile } from './hooks/useMobile'

const loaders = {
  today: () => import('./pages/Today'),
  sessions: () => import('./pages/Sessions'),
  model: () => import('./pages/Model'),
  settings: () => import('./pages/Settings'),
}
const Pages = Object.fromEntries(Object.entries(loaders).map(([k, l]) => [k, lazy(l)]))

const TABS = [
  { id: 'today', label: 'Today', icon: '⊙' },
  { id: 'sessions', label: 'Sessions', icon: '≡' },
  { id: 'model', label: 'How I trade', icon: '◌', shortLabel: 'How' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
]

// CME index futures run Sun 18:00 ET to Fri 17:00 ET, with a daily halt 17:00 to 18:00 ET.
function marketPhase() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const dow = et.getDay(), mins = et.getHours() * 60 + et.getMinutes()
  if (dow === 6 || (dow === 0 && mins < 18 * 60) || (dow === 5 && mins >= 17 * 60)) return { label: 'Closed', color: T.muted }
  if (mins >= 17 * 60 && mins < 18 * 60) return { label: 'Daily break', color: T.yellow }
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return { label: 'Cash session', color: T.green }
  return { label: 'Overnight', color: T.blue }
}

const money = (n) => `${n < 0 ? '-' : '+'}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

const GLOBAL_CSS = `
  @keyframes spin { to { transform: rotate(360deg); } }
  *, *::before, *::after { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; box-sizing: border-box; }
  html { overflow-x: hidden; }
  body { font-size: 15px; margin: 0; background: #000000; overflow-x: hidden; -webkit-tap-highlight-color: transparent; }
  input, select, textarea { font-size: 16px !important; }
  @media (min-width: 769px) { input, select, textarea { font-size: 14px !important; } }
  input::placeholder, textarea::placeholder { color: #52525b; opacity: 1; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: #ccba83 !important; }
  ::selection { background: rgba(204,186,131,0.30); color: #ecedee; }
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #2b2b2f; border-radius: 3px; }
  button { min-height: 36px; }
  .scroll-x { overflow-x: auto; -webkit-overflow-scrolling: touch; }
`

function Loading() {
  return (
    <div style={{ minHeight: 240, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 24, height: 24, borderRadius: '50%', border: `2px solid ${T.border}`, borderTopColor: T.accent, animation: 'spin 0.7s linear infinite' }} />
    </div>
  )
}

// Signed in, the journal itself; otherwise the sign-in screen (or, before a
// password is set, what to do about it).
export default function App() {
  const [config, setConfig] = useState(null)
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState(null)

  const start = useCallback(async () => {
    setErr(null)
    try {
      const c = await getConfig()
      setConfig(c)
      if (!c.auth.signedIn) { setReady(false); return }
      // The time zone: the one saved in Settings, or on first visit the
      // browser's own, saved so the server reads agents' times in it too.
      let p = await getProfile()
      if (!p.time_zone) p = await updateProfile({ time_zone: browserZone() })
      setZone(p.effective_time_zone || p.time_zone || browserZone())
      setReady(true)
    } catch (e) { setErr(e.message) }
  }, [])
  useEffect(() => { start() }, [start])
  useEffect(() => {
    const out = () => { setReady(false); setConfig((c) => (c ? { ...c, auth: { ...c.auth, signedIn: false } } : c)) }
    window.addEventListener('journal:signed-out', out)
    return () => window.removeEventListener('journal:signed-out', out)
  }, [])

  if (err) return <Shell><div style={{ color: T.red, padding: 40, textAlign: 'center' }}>{err}</div></Shell>
  if (!config) return <Shell><Loading /></Shell>
  if (!config.auth.signedIn) return <Shell><SignIn mode={config.auth.mode} configured={config.auth.configured} problem={config.auth.problem} onDone={start} /></Shell>
  if (!ready) return <Shell><Loading /></Shell>
  return <Journal config={config} />
}

function Shell({ children }) {
  return (
    <div style={{ background: T.bg, minHeight: '100vh', fontFamily: T.sans }}>
      <style>{GLOBAL_CSS}</style>
      {children}
    </div>
  )
}

function Journal({ config }) {
  const mobile = useMobile()
  const [tab, setTab] = useState('today')
  const [net, setNet] = useState(null)
  const [, tick] = useState(0)

  const refresh = useCallback(() => {
    const d = today()
    getSessions({ from: d, to: d })
      .then((r) => setNet(r.positions.length ? r.positions.reduce((s, p) => s + (p.pnl || 0), 0) : null))
      .catch(() => {})
  }, [])
  // Refreshes every five minutes, and only while the tab is in view.
  useEffect(() => { refresh(); const i = setInterval(() => { if (!document.hidden) refresh() }, 300000); return () => clearInterval(i) }, [refresh])
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 15000); return () => clearInterval(i) }, [])
  useEffect(() => { Object.values(loaders).forEach((l) => l().catch(() => {})) }, [])

  const phase = marketPhase()
  const Page = Pages[tab]

  return (
    <div style={{ background: T.bg, minHeight: '100vh', fontFamily: T.sans }}>
      <style>{GLOBAL_CSS}</style>

      <header style={{
        position: 'sticky', top: 0, zIndex: 100, background: `${T.card}f8`, backdropFilter: 'blur(12px)',
        borderBottom: `1px solid ${T.border}`, padding: mobile ? '0 14px' : '0 24px', height: mobile ? 52 : 58,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: mobile ? 10 : 22 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 30, height: 30, background: T.accent, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ color: '#0e0e10', fontWeight: 900, fontSize: 14, fontFamily: T.mono }}>T</span>
            </div>
            <span style={{ fontSize: 15, fontWeight: 800, color: T.text, letterSpacing: '-0.02em' }}>Trade journal</span>
          </div>
          {!mobile && (
            <nav style={{ display: 'flex', gap: 2 }}>
              {TABS.map((t) => {
                const active = tab === t.id
                return (
                  <button key={t.id} onClick={() => setTab(t.id)} style={{
                    background: active ? `${T.accent}14` : 'transparent', border: 'none', borderRadius: 7, padding: '7px 13px',
                    color: active ? T.accent : T.muted, fontFamily: T.sans, fontSize: 13, fontWeight: active ? 700 : 500, cursor: 'pointer',
                  }}>{t.label}</button>
                )
              })}
            </nav>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: mobile ? 10 : 16 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: T.mono, fontSize: 12, color: T.sub, lineHeight: 1.3 }}>{nowLocal12()} {zoneLabel()}</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: phase.color, letterSpacing: '0.06em', textTransform: 'uppercase', lineHeight: 1.3 }}>{phase.label}</div>
          </div>
          {net != null && (
            <div style={{ textAlign: 'right', borderLeft: `1px solid ${T.border}`, paddingLeft: mobile ? 10 : 16 }}>
              <div style={{ fontSize: 10, color: T.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Today</div>
              <div style={{ fontFamily: T.mono, fontWeight: 800, fontSize: mobile ? 15 : 17, color: net >= 0 ? T.green : T.red }}>{money(net)}</div>
            </div>
          )}
        </div>
      </header>

      <main style={{ padding: mobile ? '14px 12px calc(68px + env(safe-area-inset-bottom, 0px))' : '24px 24px 40px', maxWidth: 1320, margin: '0 auto' }}>
        <Suspense fallback={<Loading />}>
          <Page onNavigate={setTab} config={config} />
        </Suspense>
      </main>

      {mobile && (
        <nav style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 160, background: `${T.card}f5`, backdropFilter: 'blur(12px)',
          borderTop: `1px solid ${T.border}`, display: 'flex', paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}>
          {TABS.map((t) => {
            const active = tab === t.id
            return (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                flex: 1, padding: '9px 3px 7px', background: 'transparent', border: 'none', display: 'flex', flexDirection: 'column',
                alignItems: 'center', gap: 3, cursor: 'pointer', minHeight: 52,
              }}>
                <span style={{ fontSize: 17, lineHeight: 1, color: active ? T.accent : T.text, opacity: active ? 1 : 0.4 }}>{t.icon}</span>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: active ? T.accent : T.muted }}>{t.shortLabel || t.label}</span>
              </button>
            )
          })}
        </nav>
      )}
    </div>
  )
}
