import { useState } from 'react'
import { T } from '../theme'
import { Btn, Alert } from './UI'
import { signIn } from '../db'

// The password screen. Before a password exists, it says how to set one. In
// Access mode the sign-in happens at Cloudflare, so this only explains.
export default function SignIn({ mode, configured, problem, onDone }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const go = async (e) => {
    e.preventDefault()
    setBusy(true); setErr(null)
    try { await signIn(password); setPassword(''); onDone() } catch (x) { setErr(x.message) }
    setBusy(false)
  }

  const box = { maxWidth: 380, margin: '12vh auto 0', padding: '0 16px' }
  const title = <div style={{ fontSize: 22, fontWeight: 800, color: T.text, marginBottom: 6, letterSpacing: '-0.02em' }}>Trade journal</div>

  if (mode === 'access') {
    return (
      <div style={box}>
        {title}
        <div style={{ color: T.sub, fontSize: 14, lineHeight: 1.7 }}>
          {configured
            ? 'This journal signs in through Cloudflare Access, and this request did not carry a valid Access sign-in. Reload the page to sign in again. If it keeps happening, check that the Access application covers this hostname and that ACCESS_AUD matches its audience tag.'
            : 'AUTH is set to "access", but ACCESS_TEAM_DOMAIN and ACCESS_AUD are not both set, so the journal stays locked. Set them as described in the README, or set AUTH back to "password".'}
        </div>
      </div>
    )
  }

  if (!configured) {
    return (
      <div style={box}>
        {title}
        <div style={{ color: T.sub, fontSize: 14, lineHeight: 1.7 }}>
          {problem === 'weak'
            ? 'The password set for this journal is the example one or shorter than 12 characters, so sign-in is turned off.'
            : 'No password is set yet, so the journal stays locked.'} Set a password of 12 characters or more as the
          secret <code style={{ color: T.text }}>APP_PASSWORD</code> on this Worker, then reload this page.
          <br /><br />
          From a terminal in the project: <code style={{ color: T.text }}>npx wrangler secret put APP_PASSWORD</code>
          <br />
          Or in the Cloudflare dashboard: Workers &amp; Pages, this Worker, Settings, Variables and Secrets, Add, type Secret.
        </div>
      </div>
    )
  }

  return (
    <form style={box} onSubmit={go}>
      {title}
      <div style={{ color: T.muted, fontSize: 13, marginBottom: 18 }}>Enter the journal password.</div>
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password"
        aria-label="Password"
        style={{ width: '100%', background: T.card2, color: T.text, border: `1px solid ${T.border}`, borderRadius: 8, padding: '12px 14px', fontFamily: T.sans, marginBottom: 12 }} />
      <Btn accent disabled={busy || !password} style={{ width: '100%' }}>{busy ? 'Signing in' : 'Sign in'}</Btn>
      {err && <div style={{ marginTop: 12 }}><Alert type="danger">{err}</Alert></div>}
    </form>
  )
}
