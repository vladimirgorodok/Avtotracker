import { useEffect, useState, type CSSProperties } from 'react';
import { applyStatusBarLightIcons } from '../store';

/** Длительность заставки, мс */
const DURATION = 3000;
/** Длительность при включённом «уменьшении движения» */
const DURATION_REDUCED = 1500;

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Фура — тот же рисунок, что и на значке приложения (assets/icon.svg). */
function TruckMark() {
  return (
    <svg viewBox="20 330 900 500" className="splash-truck-svg" aria-hidden="true">
      <defs>
        <linearGradient id="sp-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.4" />
          <stop offset="0.55" stopColor="#ffffff" stopOpacity="0.2" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.12" />
        </linearGradient>
        <linearGradient id="sp-cab" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.5" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.16" />
        </linearGradient>
        <linearGradient id="sp-sweep" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id="sp-wind" x1="0" y1="0" x2="0.7" y2="1">
          <stop offset="0" stopColor="#d9fbff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#062b36" stopOpacity="0.45" />
        </linearGradient>
        <clipPath id="sp-trailer">
          <rect x="168" y="356" width="436" height="266" rx="28" />
        </clipPath>
      </defs>

      <g>
        <ellipse cx="524" cy="774" rx="360" ry="40" fill="#04202b" opacity="0.28" />

        <g fill="#04202a" stroke="#d8fbff" strokeOpacity="0.5" strokeWidth="6">
          <circle cx="264" cy="682" r="54" />
          <circle cx="386" cy="682" r="54" />
          <circle cx="700" cy="682" r="54" />
          <circle cx="822" cy="682" r="54" />
        </g>
        <g fill="none" stroke="#d8fbff" strokeOpacity="0.3" strokeWidth="5">
          <circle cx="264" cy="682" r="23" />
          <circle cx="386" cy="682" r="23" />
          <circle cx="700" cy="682" r="23" />
          <circle cx="822" cy="682" r="23" />
        </g>

        <rect x="176" y="600" width="664" height="44" rx="20" fill="#04202a" fillOpacity="0.55" />

        <rect
          x="168"
          y="356"
          width="436"
          height="266"
          rx="28"
          fill="url(#sp-body)"
          stroke="#e6fdff"
          strokeOpacity="0.75"
          strokeWidth="7"
        />
        <g clipPath="url(#sp-trailer)">
          <polygon points="248,356 372,356 186,622 62,622" fill="url(#sp-sweep)" />
          <rect x="308" y="372" width="5" height="236" fill="#ffffff" fillOpacity="0.16" />
          <rect x="452" y="372" width="5" height="236" fill="#ffffff" fillOpacity="0.16" />
        </g>

        <path
          d="M 616 622 L 616 450 Q 616 412 656 405 L 764 388 Q 818 381 833 421 L 860 505 L 868 505 L 868 622 Z"
          fill="url(#sp-cab)"
          stroke="#e6fdff"
          strokeOpacity="0.75"
          strokeWidth="7"
          strokeLinejoin="round"
        />
        <path
          d="M 668 462 L 762 446 L 790 508 L 668 508 Z"
          fill="url(#sp-wind)"
          stroke="#e6fdff"
          strokeOpacity="0.45"
          strokeWidth="4"
          strokeLinejoin="round"
        />

        <circle cx="858" cy="562" r="40" fill="#f0b654" opacity="0.28" />
        <circle cx="858" cy="562" r="14" fill="#ffe3ab" />

        <g fill="#ffffff">
          <rect x="54" y="450" width="78" height="14" rx="7" fillOpacity="0.3" />
          <rect x="34" y="520" width="98" height="14" rx="7" fillOpacity="0.22" />
          <rect x="62" y="590" width="64" height="14" rx="7" fillOpacity="0.16" />
        </g>
      </g>
    </svg>
  );
}

/**
 * Заставка на 3 секунды: фура выезжает по дороге, появляется название.
 * Нажатие пропускает её, при «уменьшении движения» анимации выключаются.
 */
export function Splash({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const [duration] = useState(() => (prefersReducedMotion() ? DURATION_REDUCED : DURATION));

  useEffect(() => {
    // Фон заставки тёмный — значки строки состояния делаем светлыми
    applyStatusBarLightIcons();
  }, []);

  useEffect(() => {
    const hide = setTimeout(() => setLeaving(true), Math.max(0, duration - 420));
    const finish = setTimeout(onDone, duration);
    return () => {
      clearTimeout(hide);
      clearTimeout(finish);
    };
  }, [duration, onDone]);

  return (
    <div
      className={`splash${leaving ? ' splash-leaving' : ''}`}
      style={{ '--splash-ms': `${duration}ms` } as CSSProperties}
      onClick={onDone}
      role="presentation"
    >
      <div className="splash-glow" />
      <div className="splash-horizon" />

      <div className="splash-stage">
        <div className="splash-truck">
          <div className="splash-truck-bob">
            <TruckMark />
          </div>
        </div>
        <h1 className="splash-title">АвтоБаза</h1>
        <p className="splash-sub">Путевые листы, перевозки, топливо</p>
        <div className="splash-bar">
          <span />
        </div>
      </div>

      <div className="splash-road">
        <span className="splash-dash" />
      </div>
    </div>
  );
}
