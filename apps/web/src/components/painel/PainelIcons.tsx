// Traços Lucide inline do painel do owner (portado de ad-icons.jsx do handoff).
// Uma família só, stroke 1.7, currentColor, nunca preenchido.
import type { CSSProperties } from 'react'

const AD_P: Record<string, string[]> = {
  home: ['M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z', 'M9.5 21v-6h5v6'],
  spark: [
    'M12 3.5l1.8 4.3 4.3 1.8-4.3 1.8L12 15.7l-1.8-4.3L5.9 9.6l4.3-1.8z',
    'M18.5 15.5l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7z',
  ],
  inbox: [
    'M3 12h4l2 3h6l2-3h4',
    'M3 12 5.5 5A1 1 0 0 1 6.5 4h11a1 1 0 0 1 1 .7L21 12v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  ],
  ship: ['M20 6.5 9 17.5l-5-5'],
  wallet: ['M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M16 12.5h2.5'],
  repo: ['M6 3h11a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a2 2 0 0 1 0-4h12', 'M6 3a2 2 0 0 0 0 4h12'],
  shield: ['M12 3l8 3v6c0 4.5-3.2 7.9-8 9-4.8-1.1-8-4.5-8-9V6z', 'm9 12 2 2 4-4'],
  scroll: ['M5 4.5h11a1 1 0 0 1 1 1V18a2 2 0 0 0 2 2H7a2 2 0 0 1-2-2z', 'M9 8.5h5M9 12h5'],
  cog: [
    'M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z',
    'M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a1.7 1.7 0 1 1-2.4 2.4l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a1.7 1.7 0 1 1-3.4 0v-.1a1.6 1.6 0 0 0-2.7-1.2l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1A1.6 1.6 0 0 0 4 15H3.8a1.7 1.7 0 1 1 0-3.4H4a1.6 1.6 0 0 0 1.1-2.7L5 8.8a1.7 1.7 0 1 1 2.4-2.4l.1.1A1.6 1.6 0 0 0 10 5.4V5.2a1.7 1.7 0 1 1 3.4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a1.7 1.7 0 1 1 0 3.4h-.2a1.6 1.6 0 0 0-1.5 1z',
  ],
  dots: ['M5 12h.01M12 12h.01M19 12h.01'],
  arrow: ['M5 12h13', 'm12 5.5 6.5 6.5-6.5 6.5'],
  chev: ['m9 6 5 6-5 6'],
  chevD: ['m6 9.5 6 5 5.8-5'],
  chevU: ['m6 14.5 6-5 5.8 5'],
  check: ['M20 6.5 9 17.5l-5-5'],
  send: ['M4 11.5 20.5 4l-7 16.5-2.5-7z'],
  sun: [
    'M12 7.9a4.1 4.1 0 1 0 0 8.2 4.1 4.1 0 0 0 0-8.2z',
    'M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  ],
  moon: ['M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z'],
  bell: ['M18 15V10a6 6 0 1 0-12 0v5l-1.5 3h15z', 'M10 21h4'],
  alert: ['M12 3.5 21 20H3z', 'M12 10v4', 'M12 17h.01'],
  clock: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 7.5V12l3 2'],
  ext: [
    'M14.5 3.5h6v6',
    'M10 14 20.5 3.5',
    'M20.5 14v5.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1H10',
  ],
  plus: ['M12 5.5v13', 'M5.5 12h13'],
  filter: ['M4 6h16', 'M7 12h10', 'M10 18h4'],
  tg: ['M21 4 3 11l5 2 2 6 3.5-4.5L19 18z'],
  user: [
    'M12 4a3.6 3.6 0 1 0 0 7.2A3.6 3.6 0 0 0 12 4z',
    'M4.5 20.5c0-3.6 3.4-5.5 7.5-5.5s7.5 1.9 7.5 5.5',
  ],
  refresh: [
    'M3 12a9 9 0 0 1 15-6.7L21 8',
    'M21 3v5h-5',
    'M21 12a9 9 0 0 1-15 6.7L3 16',
    'M3 21v-5h5',
  ],
  mark: ['M6 8.4v7.2', 'M8 6h4.6a3 3 0 0 1 3 3', 'M8 18h4.6a3 3 0 0 0 3-3'],
}

export function Ad({
  n,
  s = 18,
  w = 1.7,
  style,
}: {
  n: string
  s?: number
  w?: number
  style?: CSSProperties
}) {
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      {(AD_P[n] ?? []).map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  )
}

export function AdMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="6" cy="18" r="2.4" />
      <circle cx="18" cy="12" r="2.4" />
      <path d="M6 8.4v7.2M8 6h4.6a3 3 0 0 1 3 3v0M8 18h4.6a3 3 0 0 0 3-3v0" />
    </svg>
  )
}
