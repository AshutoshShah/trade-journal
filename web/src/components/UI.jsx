import { T } from '../theme'

const S = {
  label: {
    display: 'block',
    fontSize: '11px',
    fontWeight: 700,
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    color: T.muted,
    marginBottom: '7px',
    fontFamily: T.sans,
  },
  input: {
    width: '100%',
    padding: '12px 14px',
    background: T.card2,
    border: `1px solid ${T.border}`,
    borderRadius: '8px',
    color: T.text,
    fontFamily: T.sans,
    fontSize: '15px',
    lineHeight: '1.4',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.15s, background 0.15s',
    WebkitAppearance: 'none',
  },
}

const onFocus = e => { e.target.style.borderColor = T.focusBorder; e.target.style.background = T.focusBg }
const onBlur  = e => { e.target.style.borderColor = T.border;      e.target.style.background = T.card2 }

export function Input({ label, value, onChange, type='text', placeholder, small, style={} }) {
  const isNum = type === 'number'
  const hasVal = value !== '' && value !== null && value !== undefined
  return (
    <div style={{ display:'flex', flexDirection:'column', flex: small?'none':'1', minWidth: small?76:114, ...style }}>
      {label && <label style={S.label}>{label}</label>}
      <input
        type={type} value={value ?? ''} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        step={isNum?'any':undefined}
        style={{
          ...S.input,
          fontFamily: isNum ? T.mono : T.sans,
          letterSpacing: isNum ? '0.02em' : 'normal',
          color: hasVal ? T.text : T.label,
          fontWeight: hasVal ? 500 : 400,
        }}
        onFocus={onFocus} onBlur={onBlur}
      />
    </div>
  )
}

export function Textarea({ label, value, onChange, placeholder, rows=3 }) {
  return (
    <div style={{ display:'flex', flexDirection:'column' }}>
      {label && <label style={S.label}>{label}</label>}
      <textarea
        value={value} placeholder={placeholder} rows={rows}
        onChange={e => onChange(e.target.value)}
        style={{ ...S.input, resize:'vertical', lineHeight:'1.7', minHeight: rows*26+'px', fontSize:'15px' }}
        onFocus={onFocus} onBlur={onBlur}
      />
    </div>
  )
}

export function Tag({ label, value, onChange, options, small, labelExtra }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', flex:small?'none':'1', minWidth:small?92:134 }}>
      {label && (
        <div style={{ display:'flex', alignItems:'center', gap:'6px', marginBottom:'7px' }}>
          <label style={{ ...S.label, marginBottom:0 }}>{label}</label>
          {labelExtra}
        </div>
      )}
      <select
        value={value} onChange={e => onChange(e.target.value)}
        style={{
          ...S.input, cursor:'pointer',
          backgroundImage:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='7' viewBox='0 0 12 7'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%238a7260' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
          backgroundRepeat:'no-repeat',
          backgroundPosition:'right 12px center',
          paddingRight:'34px',
        }}
        onFocus={onFocus} onBlur={onBlur}
      >
        <option value="">—</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  )
}

const SC = { 1:T.red, 2:T.orange, 3:T.yellow, 4:T.green, 5:T.green }
export function ScoreSelect({ value, onChange }) {
  return (
    <div style={{ display:'flex', gap:'7px' }}>
      {[1,2,3,4,5].map(n => {
        const active = parseInt(value)===n, c=SC[n]
        return (
          <button key={n} onClick={() => onChange(n)} style={{
            width:'46px', height:'42px',
            border:`1.5px solid ${active?c:T.border}`,
            background: active ? `${c}30` : T.card2,
            color: active ? c : T.muted,
            cursor:'pointer', fontFamily:T.mono, fontSize:'15px',
            fontWeight: active?700:400,
            transition:'all 0.12s', borderRadius:'8px',
          }}>{n}</button>
        )
      })}
    </div>
  )
}

export function Btn({ children, onClick, accent, small, disabled, style={} }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: accent ? T.accent : T.card3,
      color:      accent ? '#000000' : T.sub,
      border:     `1.5px solid ${accent ? T.accent : T.borderLight}`,
      padding:    small ? '8px 16px' : '11px 24px',
      borderRadius: '8px',
      fontFamily: T.sans,
      fontSize:   small ? '13px' : '15px',
      fontWeight: 700,
      cursor:     disabled ? 'not-allowed' : 'pointer',
      opacity:    disabled ? 0.4 : 1,
      transition: 'all 0.12s',
      minHeight:  small ? '36px' : '44px',
      whiteSpace: 'nowrap',
      letterSpacing: '0.01em',
      ...style,
    }}>{children}</button>
  )
}

const AS = {
  danger: { bg:'rgba(232,88,88,0.1)',    border:'rgba(232,88,88,0.3)',    color:'#e88080', icon:'⚠' },
  warn:   { bg:'rgba(204,186,131,0.12)',   border:'rgba(204,186,131,0.35)', color:T.accent,  icon:'△' },
  ok:     { bg:'rgba(114,214,114,0.1)',   border:'rgba(114,214,114,0.3)', color:'#82d882', icon:'✓' },
  info:   { bg:'rgba(104,152,224,0.1)',   border:'rgba(104,152,224,0.3)', color:'#90b8e8', icon:'ℹ' },
}
export function Alert({ type='info', children }) {
  const s = AS[type]
  return (
    <div style={{
      background:s.bg, border:`1px solid ${s.border}`, borderLeft:`3px solid ${s.color}`,
      padding:'13px 17px', borderRadius:'8px',
      display:'flex', gap:'11px', alignItems:'flex-start',
    }}>
      <span style={{ color:s.color, fontSize:'14px', flexShrink:0, marginTop:'1px' }}>{s.icon}</span>
      <span style={{ color:s.color, fontSize:'14px', fontFamily:T.sans, lineHeight:'1.6' }}>{children}</span>
    </div>
  )
}

export function Row({ children, gap=10, mb=14 }) {
  return <div style={{ display:'flex', gap:`${gap}px`, marginBottom:`${mb}px`, flexWrap:'wrap' }}>{children}</div>
}

export function Card({ children, style={} }) {
  return (
    <div style={{
      background:T.card, border:`1px solid ${T.border}`,
      padding:'22px', borderRadius:'12px',
      boxShadow: '0 2px 12px rgba(0,0,0,0.25)',
      ...style,
    }}>
      {children}
    </div>
  )
}

export function SectionTitle({ children }) {
  return (
    <div style={{
      fontSize:'12px', fontWeight:800, letterSpacing:'0.09em',
      color:T.accent, textTransform:'uppercase',
      marginBottom:'18px',
      display:'flex', alignItems:'center', gap:'10px',
      fontFamily:T.sans,
    }}>
      <span style={{ width:'3px', height:'14px', background:T.accent, borderRadius:'2px', display:'inline-block', flexShrink:0 }} />
      {children}
    </div>
  )
}

export function FieldLabel({ children }) {
  return <div style={S.label}>{children}</div>
}

export function CheckRow({ label, checked, onChange, note }) {
  return (
    <div onClick={() => onChange(!checked)} style={{
      display:'flex', gap:'14px', padding:'14px 0',
      borderBottom:`1px solid ${T.border}`,
      cursor:'pointer', alignItems:'flex-start', minHeight:'50px',
    }}>
      <div style={{
        width:'21px', height:'21px', flexShrink:0, marginTop:'1px',
        border:`1.5px solid ${checked?T.accent:T.borderLight}`,
        background: checked ? T.accent : 'transparent',
        borderRadius:'5px', transition:'all 0.12s',
        display:'flex', alignItems:'center', justifyContent:'center',
      }}>
        {checked && <span style={{ color:'#000000', fontSize:'12px', fontWeight:800, lineHeight:1 }}>✓</span>}
      </div>
      <div>
        <div style={{ color:checked?T.text:T.sub, fontSize:'15px', lineHeight:'1.45', fontFamily:T.sans }}>{label}</div>
        {note && <div style={{ color:T.muted, fontSize:'13px', marginTop:'4px' }}>{note}</div>}
      </div>
    </div>
  )
}

// ── Tooltip — hover/click info icon ──────────────────────────────
import { useState, useRef, useEffect } from 'react'

export function Tooltip({ content, title, children }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const trigger = children || (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: '16px', height: '16px', borderRadius: '50%',
      background: open ? `${T.accent}25` : `${T.border}`,
      border: `1px solid ${open ? T.accent : T.borderLight}`,
      color: open ? T.accent : T.muted,
      fontSize: '9px', fontWeight: 700, cursor: 'pointer',
      flexShrink: 0, userSelect: 'none',
      transition: 'all 0.15s',
      fontFamily: T.mono,
    }}>ⓘ</span>
  )

  return (
    <span
      ref={ref}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
    >
      {trigger}
      {open && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 8px)', left: '50%',
          transform: 'translateX(-50%)',
          background: T.card2, border: `1px solid ${T.accent}35`,
          borderRadius: '10px', padding: '14px 16px',
          width: '280px', zIndex: 8000,
          boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
          pointerEvents: 'none',
        }}>
          {/* Arrow */}
          <div style={{
            position: 'absolute', bottom: '-6px', left: '50%',
            width: '10px', height: '10px', background: T.card2,
            border: `1px solid ${T.accent}35`, borderTop: 'none', borderLeft: 'none',
            transform: 'translateX(-50%) rotate(45deg)',
          }} />
          {title && (
            <div style={{
              fontSize: '11px', fontWeight: 700, color: T.accent,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              marginBottom: '7px', fontFamily: T.mono,
            }}>{title}</div>
          )}
          <div style={{
            fontSize: '13px', color: T.sub, lineHeight: '1.65',
            whiteSpace: 'pre-wrap',
          }}>{content}</div>
        </div>
      )}
    </span>
  )
}

// ── LabelWithTip — field label + inline tooltip icon ─────────────
export function LabelWithTip({ label, title, tip }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '6px',
      fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em',
      textTransform: 'uppercase', color: T.muted,
      marginBottom: '7px', fontFamily: T.sans,
    }}>
      {label}
      <Tooltip title={title || label} content={tip} />
    </div>
  )
}

export function AuthInput({ label, value, onChange, type='text', placeholder, error, onKeyDown }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'6px' }}>
      <label style={{ ...S.label, marginBottom:0 }}>{label}</label>
      <input
        type={type} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)} onKeyDown={onKeyDown}
        style={{ ...S.input, fontSize:'16px', padding:'14px 16px', borderRadius:'9px', border:`1px solid ${error?T.red:T.border}` }}
        onFocus={e => { e.target.style.borderColor=T.focusBorder; e.target.style.background=T.focusBg }}
        onBlur={e  => { e.target.style.borderColor=error?T.red:T.border; e.target.style.background=T.card2 }}
      />
      {error && <div style={{ color:T.red, fontSize:'13px' }}>{error}</div>}
    </div>
  )
}
