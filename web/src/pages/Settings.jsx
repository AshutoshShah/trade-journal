import { useState, useEffect, useCallback } from 'react'
import { T, browserZone, setZone } from '../theme'
import { Card, SectionTitle, Btn, Alert } from '../components/UI'
import { getProfile, updateProfile, listKeys, createKey, revokeKey, signOut } from '../db'
import { useMobile } from '../hooks/useMobile'
import { DEFAULT_LABELS } from '../lib'

const field = { background: T.card2, color: T.text, border: `1px solid ${T.border}`, borderRadius: 7, padding: '8px 10px', fontFamily: T.sans }
const note = { color: T.muted, fontSize: 13, lineHeight: 1.6 }

const zones = (() => {
  try { return Intl.supportedValuesOf('timeZone') } catch { return [] }
})()

// The prompt to give an agent along with its key.
const agentPrompt = (origin, key) => `You can send my futures trades to my trading journal.

Journal API: ${origin}/ingest/v1
API key: ${key}
Send the key on every request in the header "X-API-Key".

First read the instructions at ${origin}/ingest/v1/help (send the key with that request too) and follow them exactly. Then call GET ${origin}/ingest/v1/ping to check the key works.

Whenever I give you a trade log, an export, or a screenshot of my platform's trades, send every individual fill for that day to POST ${origin}/ingest/v1/day as the instructions describe. Do not work out P&L or averages; the journal does that. Read the warnings in the response and tell me about anything that looks wrong. Keep this key private.`

function Keys() {
  const [keys, setKeys] = useState(null)
  const [name, setName] = useState('')
  const [made, setMade] = useState(null)
  const [copied, setCopied] = useState('')
  const [err, setErr] = useState(null)
  const load = useCallback(() => listKeys().then(setKeys).catch((e) => setErr(e.message)), [])
  useEffect(() => { load() }, [load])

  const make = async () => {
    setErr(null)
    try { setMade(await createKey(name)); setName(''); load() } catch (e) { setErr(e.message) }
  }
  const revoke = async (k) => {
    if (!window.confirm(`Revoke the key "${k.name}"? Anything using it stops working at once. Days it already sent are kept.`)) return
    try { await revokeKey(k.id); load() } catch (e) { setErr(e.message) }
  }
  const copy = async (text, what) => {
    try { await navigator.clipboard.writeText(text); setCopied(what) } catch { setCopied('') }
  }
  const origin = window.location.origin

  return (
    <Card style={{ padding: 20 }}>
      <SectionTitle>Agents and scripts</SectionTitle>
      <div style={{ ...note, marginBottom: 14 }}>
        An agent (a personal AI assistant, a bot, or a script) can send your trades here, so nothing has to be typed in.
        Make a key for it, then give it the prompt below. Each key has a name, and what it sends is stored under that name.
        The instructions it reads are at <code style={{ color: T.sub }}>{origin}/ingest/v1/help</code>.
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, such as my-agent" aria-label="Key name"
          style={{ ...field, flex: 1, minWidth: 180 }} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) make() }} />
        <Btn small accent onClick={make} disabled={!name.trim()}>Make a key</Btn>
      </div>
      {err && <div style={{ marginBottom: 12 }}><Alert type="danger">{err}</Alert></div>}

      {made && (
        <div style={{ background: T.card2, border: `1px solid ${T.accent}55`, borderRadius: 9, padding: 14, marginBottom: 14 }}>
          <div style={{ color: T.text, fontSize: 14, marginBottom: 8 }}>
            Key for <b>{made.name}</b>. Copy it now: it is shown only once.
          </div>
          <code style={{ display: 'block', color: T.accent, fontSize: 13, wordBreak: 'break-all', marginBottom: 10 }}>{made.key}</code>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <Btn small onClick={() => copy(made.key, 'key')}>{copied === 'key' ? 'Key copied' : 'Copy key'}</Btn>
            <Btn small accent onClick={() => copy(agentPrompt(origin, made.key), 'prompt')}>{copied === 'prompt' ? 'Prompt copied' : 'Copy prompt for the agent'}</Btn>
            <Btn small onClick={() => { setMade(null); setCopied('') }}>Done</Btn>
          </div>
          <pre style={{ whiteSpace: 'pre-wrap', color: T.sub, fontSize: 12, lineHeight: 1.55, margin: 0, fontFamily: T.mono }}>{agentPrompt(origin, made.key)}</pre>
        </div>
      )}

      {keys && keys.length > 0 && (
        <div className="scroll-x">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ color: T.muted, textAlign: 'left' }}>
              <th style={{ padding: '6px 8px 6px 0', fontWeight: 600 }}>Name</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>Starts</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>Made</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>Last used</th>
              <th />
            </tr></thead>
            <tbody>{keys.map((k) => (
              <tr key={k.id} style={{ borderTop: `1px solid ${T.border}`, color: T.text }}>
                <td style={{ padding: '8px 8px 8px 0' }}>{k.name}</td>
                <td style={{ padding: 8, fontFamily: T.mono, color: T.sub }}>{k.prefix}…</td>
                <td style={{ padding: 8, color: T.sub }}>{k.created_at.slice(0, 10)}</td>
                <td style={{ padding: 8, color: T.sub }}>{k.last_used_at ? k.last_used_at.slice(0, 10) : 'Never'}</td>
                <td style={{ padding: '8px 0', textAlign: 'right' }}><Btn small onClick={() => revoke(k)}>Revoke</Btn></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {keys && !keys.length && !made && <div style={note}>No keys yet.</div>}
    </Card>
  )
}

export default function Settings({ config }) {
  const mobile = useMobile()
  const [profile, setProfile] = useState(null)
  const [tz, setTz] = useState('')
  const [labels, setLabels] = useState('')
  const [msg, setMsg] = useState(null)
  const [err, setErr] = useState(null)
  const detected = browserZone()

  useEffect(() => {
    getProfile().then((p) => {
      setProfile(p)
      setTz(p.time_zone || detected)
      setLabels((Array.isArray(p.labels) && p.labels.length ? p.labels : DEFAULT_LABELS).join(', '))
    }).catch((e) => setErr(e.message))
  }, [detected])

  const saveZone = async (value) => {
    setErr(null); setMsg(null)
    try {
      const p = await updateProfile({ time_zone: value })
      setProfile(p); setTz(value); setZone(value)
      setMsg(`Times are now shown in ${value}, and agents' times without an offset are read in it.`)
    } catch (e) { setErr(e.message) }
  }
  const saveLabels = async () => {
    setErr(null); setMsg(null)
    const list = [...new Set(labels.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 20).map((s) => s.slice(0, 40))
    try { const p = await updateProfile({ labels: list }); setProfile(p); setLabels(list.join(', ')); setMsg('Labels saved.') } catch (e) { setErr(e.message) }
  }
  const leave = async () => { await signOut().catch(() => {}); window.location.reload() }

  if (!profile) return err ? <Alert type="danger">{err}</Alert> : <div style={{ color: T.muted, padding: 30, textAlign: 'center' }}>Loading</div>

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }}>
      <div style={{ fontSize: mobile ? 22 : 26, fontWeight: 800, color: T.text, letterSpacing: '-0.02em' }}>Settings</div>
      {msg && <Alert type="ok">{msg}</Alert>}
      {err && <Alert type="danger">{err}</Alert>}

      <Card style={{ padding: 20 }}>
        <SectionTitle>Time zone</SectionTitle>
        <div style={{ ...note, marginBottom: 12 }}>
          Times on every page are shown in this zone, and a time an agent sends without an offset is read in it. It was set from this
          browser on your first visit. Trading days and the time-of-day breakdowns stay on New York time, where the session is defined.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={tz} onChange={(e) => setTz(e.target.value)} style={{ ...field, minWidth: 240 }} aria-label="Time zone">
            {(zones.includes(tz) ? zones : [tz, ...zones]).map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
          <Btn small accent onClick={() => saveZone(tz)} disabled={tz === profile.time_zone}>Save</Btn>
          {detected !== profile.time_zone && <Btn small onClick={() => saveZone(detected)}>Use this browser’s ({detected})</Btn>}
        </div>
      </Card>

      <Keys />

      <Card style={{ padding: 20 }}>
        <SectionTitle>Labels for positions</SectionTitle>
        <div style={{ ...note, marginBottom: 12 }}>
          The choices in the Label column on Sessions, separated by commas. Sessions breaks results down by label.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input value={labels} onChange={(e) => setLabels(e.target.value)} style={{ ...field, flex: 1, minWidth: 220 }} aria-label="Labels" />
          <Btn small accent onClick={saveLabels}>Save</Btn>
        </div>
      </Card>

      <Card style={{ padding: 20 }}>
        <SectionTitle>Screenshots</SectionTitle>
        <div style={note}>
          {config.images
            ? 'On. Screenshots are stored in this Worker’s R2 bucket.'
            : 'Off. Screenshots need an R2 bucket bound to this Worker as IMG. The README explains how to turn them on.'}
        </div>
      </Card>

      {config.auth.mode === 'password' && (
        <Card style={{ padding: 20 }}>
          <SectionTitle>Sign out</SectionTitle>
          <div style={{ ...note, marginBottom: 12 }}>
            Signs this browser out. To change the password, set the APP_PASSWORD secret again; every browser is then signed out.
          </div>
          <Btn small onClick={leave}>Sign out</Btn>
        </Card>
      )}
    </div>
  )
}
