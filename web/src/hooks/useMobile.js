import { useState, useEffect } from 'react'

export function useMobile(breakpoint = 768) {
  const query = `(max-width: ${breakpoint - 1}px)`
  const [mobile, setMobile] = useState(
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false
  )

  useEffect(() => {
    const media = window.matchMedia(query)
    let raf = null

    const update = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setMobile(media.matches))
    }

    update()
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', update)
    } else if (typeof media.addListener === 'function') {
      media.addListener(update)
    }

    return () => {
      if (typeof media.removeEventListener === 'function') {
        media.removeEventListener('change', update)
      } else if (typeof media.removeListener === 'function') {
        media.removeListener(update)
      }
      if (raf) cancelAnimationFrame(raf)
    }
  }, [query])

  return mobile
}
