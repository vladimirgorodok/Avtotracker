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

/**
 * Фура — подробный рисунок: полуприцеп со стойками каркаса, контрольной полосой,
 * фонарями, тележкой и опорными ногами; тягач с кабиной, стёклами, зеркалами,
 * фарой, бампером, топливным баком и выхлопной трубой.
 * Боковой вид, все колёса — одна и та же группа sp-wheel.
 */
export function TruckMark() {
  return (
    <svg viewBox="30 40 950 340" className="splash-truck-svg" aria-hidden="true">
      <defs>
        <linearGradient id="sp-alu" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#feffff" />
          <stop offset="0.3" stopColor="#eaf1f7" />
          <stop offset="0.62" stopColor="#c9d6e2" />
          <stop offset="0.92" stopColor="#a3b6c7" />
          <stop offset="1" stopColor="#8ea3b5" />
        </linearGradient>
        <linearGradient id="sp-cab" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.38" stopColor="#eef4fa" />
          <stop offset="0.85" stopColor="#c6d5e3" />
          <stop offset="1" stopColor="#aebfd0" />
        </linearGradient>
        <linearGradient id="sp-glass" x1="0.08" y1="0" x2="0.92" y2="1">
          <stop offset="0" stopColor="#0b2537" />
          <stop offset="0.42" stopColor="#2d5f80" />
          <stop offset="1" stopColor="#0c2032" />
        </linearGradient>
        <linearGradient id="sp-tire" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3b4650" />
          <stop offset="0.55" stopColor="#232b33" />
          <stop offset="1" stopColor="#0c1015" />
        </linearGradient>
        <linearGradient id="sp-rim" x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="#fdfeff" />
          <stop offset="0.5" stopColor="#d4dee8" />
          <stop offset="1" stopColor="#8a9aa9" />
        </linearGradient>
        <linearGradient id="sp-chrome" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#8fa1b2" />
          <stop offset="0.32" stopColor="#f5fafe" />
          <stop offset="0.6" stopColor="#dce6ef" />
          <stop offset="1" stopColor="#7e8fa0" />
        </linearGradient>
        <linearGradient id="sp-frame" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#323d49" />
          <stop offset="0.35" stopColor="#1a222a" />
          <stop offset="1" stopColor="#0d1216" />
        </linearGradient>
        <linearGradient id="sp-ao" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="1" stopColor="#0a1c2c" stopOpacity="0.45" />
        </linearGradient>
        <radialGradient id="sp-lamp" cx="0.5" cy="0.32" r="0.85">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.45" stopColor="#e6f1f9" />
          <stop offset="1" stopColor="#a6c2d6" />
        </radialGradient>
        <pattern id="sp-ribs" width="26" height="8" patternUnits="userSpaceOnUse">
          <rect width="3" height="8" fill="#9fb1c1" opacity="0.45" />
          <rect x="3" width="1.8" height="8" fill="#ffffff" opacity="0.7" />
        </pattern>
        <pattern id="sp-tape" width="30" height="8" patternUnits="userSpaceOnUse">
          <rect width="15" height="8" fill="#d63a2b" />
          <rect x="15" width="15" height="8" fill="#eef2f6" />
        </pattern>
        <clipPath id="sp-trailer-clip">
          <rect x="56" y="70" width="644" height="182" rx="10" />
        </clipPath>

        <g id="sp-wheel">
          <circle r="46" fill="url(#sp-tire)" />
          <circle r="46" fill="none" stroke="#080b0e" strokeWidth="2.5" />
          <circle r="40.5" fill="none" stroke="#4d5762" strokeWidth="3.5" opacity="0.5" />
          <circle r="31" fill="url(#sp-rim)" stroke="#76889a" strokeWidth="2.5" />
          <g fill="#57616e">
            <circle cx="17" cy="9.8" r="6.4" />
            <circle cx="0" cy="19.6" r="6.4" />
            <circle cx="-17" cy="9.8" r="6.4" />
            <circle cx="-17" cy="-9.8" r="6.4" />
            <circle cx="0" cy="-19.6" r="6.4" />
            <circle cx="17" cy="-9.8" r="6.4" />
          </g>
          <circle r="11" fill="url(#sp-rim)" stroke="#8394a4" strokeWidth="2.5" />
          <g fill="#7c8b9a">
            <circle cx="6.8" cy="0" r="2.2" />
            <circle cx="3.4" cy="5.9" r="2.2" />
            <circle cx="-3.4" cy="5.9" r="2.2" />
            <circle cx="-6.8" cy="0" r="2.2" />
            <circle cx="-3.4" cy="-5.9" r="2.2" />
            <circle cx="3.4" cy="-5.9" r="2.2" />
          </g>
          <circle r="3.4" fill="#c8d2dc" />
        </g>
      </defs>

      {/* тень на дороге */}
      <ellipse cx="492" cy="356" rx="446" ry="19" fill="#04101e" opacity="0.45" />

      {/* ================= ПОЛУПРИЦЕП ================= */}
      <g>
        <rect
          x="56"
          y="70"
          width="644"
          height="182"
          rx="10"
          fill="url(#sp-alu)"
          stroke="#75899c"
          strokeWidth="2.5"
        />
        <rect
          x="58"
          y="86"
          width="640"
          height="150"
          fill="url(#sp-ribs)"
          clipPath="url(#sp-trailer-clip)"
        />

        {/* обвязки */}
        <rect x="60" y="74" width="636" height="6" rx="3" fill="#ffffff" opacity="0.85" />
        <rect x="60" y="82" width="636" height="3" fill="#9db0c0" opacity="0.8" />
        <rect x="60" y="238" width="636" height="3" fill="#9db0c0" opacity="0.8" />
        <rect x="60" y="244" width="636" height="8" rx="3" fill="#b5c4d1" />

        {/* блик по борту */}
        <rect
          x="300"
          y="86"
          width="90"
          height="150"
          fill="#ffffff"
          opacity="0.22"
          clipPath="url(#sp-trailer-clip)"
        />

        {/* стойки каркаса */}
        <rect x="62" y="74" width="5" height="176" fill="#8fa2b3" opacity="0.9" />
        <rect x="690" y="74" width="5" height="176" fill="#8fa2b3" opacity="0.9" />

        {/* задние двери: петли и запоры */}
        <rect x="66" y="108" width="13" height="8" rx="3" fill="#8294a5" />
        <rect x="66" y="150" width="13" height="8" rx="3" fill="#8294a5" />
        <rect x="66" y="200" width="13" height="8" rx="3" fill="#8294a5" />
        <rect x="68" y="176" width="4" height="18" rx="2" fill="#75899c" />
        <rect x="74" y="176" width="9" height="18" rx="3" fill="#98aabb" />

        {/* габаритные огни */}
        <g fill="#ffc24d">
          <circle cx="98" cy="92" r="4.4" />
          <circle cx="196" cy="92" r="4.4" />
          <circle cx="294" cy="92" r="4.4" />
          <circle cx="392" cy="92" r="4.4" />
          <circle cx="490" cy="92" r="4.4" />
          <circle cx="588" cy="92" r="4.4" />
          <circle cx="686" cy="92" r="4.4" />
        </g>

        {/* контрольная полоса */}
        <rect
          x="58"
          y="244"
          width="640"
          height="8"
          fill="url(#sp-tape)"
          clipPath="url(#sp-trailer-clip)"
        />

        {/* задние фонари */}
        <rect x="58" y="164" width="6" height="14" rx="3" fill="#ffbf3f" />
        <rect x="58" y="186" width="6" height="30" rx="3" fill="#ff4b3e" />

        {/* тень снизу */}
        <rect x="60" y="238" width="636" height="14" fill="url(#sp-ao)" />
      </g>

      {/* нижняя обвязка прицепа */}
      <rect x="86" y="252" width="640" height="16" rx="6" fill="#25313c" />
      <rect x="86" y="252" width="640" height="5" rx="2.5" fill="#43525f" opacity="0.8" />

      {/* крыло над задней тележкой прицепа */}
      <path
        d="M 92 252 L 92 264 Q 92 292 150 292 L 234 292 Q 292 292 292 264 L 292 252"
        fill="none"
        stroke="#b3c2cf"
        strokeWidth="8"
        strokeLinecap="round"
      />

      {/* опорные ноги */}
      <rect x="544" y="252" width="17" height="66" rx="4" fill="#c8d4e0" stroke="#8294a5" strokeWidth="2" />
      <rect x="554" y="264" width="7" height="40" rx="3" fill="#93a5b6" />
      <rect x="532" y="312" width="42" height="11" rx="4" fill="#8294a5" />

      {/* брызговик прицепа */}
      <rect x="284" y="268" width="22" height="70" rx="5" fill="#1b232c" />

      {/* ================= ТЯГАЧ ================= */}
      {/* выхлопная труба */}
      <rect x="704" y="98" width="15" height="196" rx="6" fill="url(#sp-chrome)" stroke="#8294a5" strokeWidth="2" />
      <g stroke="#9fb0bf" strokeWidth="2" opacity="0.75">
        <line x1="704" y1="132" x2="719" y2="132" />
        <line x1="704" y1="152" x2="719" y2="152" />
        <line x1="704" y1="172" x2="719" y2="172" />
      </g>
      <rect x="700" y="90" width="23" height="11" rx="5" fill="url(#sp-chrome)" stroke="#8294a5" strokeWidth="2" />

      {/* дефлектор на крыше */}
      <path
        d="M 724 70 L 724 96 L 856 96 Z"
        fill="url(#sp-cab)"
        stroke="#8294a5"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path d="M 730 76 L 844 94" stroke="#ffffff" strokeWidth="3" opacity="0.75" fill="none" />

      {/* кабина */}
      <path
        d="M 724 292 L 724 112 Q 724 96 742 96 L 866 96 L 900 142 L 900 292 L 890 292 A 52 52 0 0 0 786 292 Z"
        fill="url(#sp-cab)"
        stroke="#75899c"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path d="M 734 108 L 858 100" stroke="#ffffff" strokeWidth="3" opacity="0.8" fill="none" />

      {/* стёкла */}
      <path
        d="M 830 110 L 874 110 L 896 146 L 830 146 Z"
        fill="url(#sp-glass)"
        stroke="#5b7a94"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path d="M 836 116 L 866 114 L 876 124" fill="none" stroke="#c2dced" strokeWidth="3" opacity="0.5" />
      <rect x="768" y="112" width="54" height="80" rx="10" fill="url(#sp-glass)" stroke="#5b7a94" strokeWidth="2.5" />
      <rect x="772" y="117" width="19" height="28" rx="6" fill="#c2dced" opacity="0.22" />
      <rect x="738" y="116" width="22" height="74" rx="8" fill="url(#sp-glass)" stroke="#5b7a94" strokeWidth="2.5" />

      {/* дверь */}
      <path d="M 762 108 L 762 288" fill="none" stroke="#8294a5" strokeWidth="2.5" />
      <path d="M 834 110 L 834 288" fill="none" stroke="#8294a5" strokeWidth="2.5" />
      <rect x="804" y="196" width="22" height="7" rx="3" fill="#93a5b6" />
      <path d="M 724 196 Q 742 204 762 204" fill="none" stroke="#8294a5" strokeWidth="2" />
      <rect x="734" y="240" width="70" height="46" rx="8" fill="#ffffff" opacity="0.15" />

      {/* решётка */}
      <rect x="882" y="192" width="18" height="62" rx="6" fill="#a9b9c8" />
      <g stroke="#eef4f9" strokeWidth="3.2" opacity="0.9">
        <line x1="884" y1="202" x2="898" y2="202" />
        <line x1="884" y1="214" x2="898" y2="214" />
        <line x1="884" y1="226" x2="898" y2="226" />
        <line x1="884" y1="238" x2="898" y2="238" />
      </g>

      {/* фара */}
      <rect x="856" y="220" width="34" height="26" rx="12" fill="url(#sp-lamp)" stroke="#8fa2b3" strokeWidth="2.5" />
      <rect x="858" y="250" width="30" height="9" rx="4" fill="#ffbf3f" />

      {/* бампер */}
      <rect x="890" y="256" width="40" height="40" rx="11" fill="#222c36" stroke="#4a5663" strokeWidth="2" />
      <rect x="888" y="288" width="44" height="10" rx="5" fill="url(#sp-chrome)" />
      <circle cx="899" cy="272" r="6" fill="#ffe7ab" opacity="0.9" />

      {/* зеркала */}
      <path d="M 888 118 L 930 138" stroke="#93a5b6" strokeWidth="5" fill="none" strokeLinecap="round" />
      <path d="M 890 190 L 930 196" stroke="#93a5b6" strokeWidth="5" fill="none" strokeLinecap="round" />
      <rect x="922" y="126" width="19" height="70" rx="8" fill="#222c36" stroke="#4a5663" strokeWidth="2" />
      <rect x="925" y="131" width="13" height="60" rx="5" fill="url(#sp-glass)" />

      {/* огни на крыше кабины */}
      <g fill="#ffc24d">
        <circle cx="806" cy="91" r="4" />
        <circle cx="826" cy="90" r="4" />
        <circle cx="844" cy="91" r="4" />
      </g>

      {/* рама тягача и топливный бак */}
      <rect x="560" y="280" width="330" height="20" rx="7" fill="url(#sp-frame)" />
      <rect x="560" y="280" width="330" height="4" rx="2" fill="#48565f" opacity="0.7" />
      <rect x="744" y="292" width="54" height="40" rx="19" fill="url(#sp-chrome)" stroke="#7e8fa0" strokeWidth="2" />
      <g stroke="#9fb0bf" strokeWidth="2.5" opacity="0.85">
        <line x1="762" y1="294" x2="762" y2="330" />
        <line x1="782" y1="294" x2="782" y2="330" />
      </g>

      {/* крыло над ведущими колёсами тягача */}
      <path
        d="M 550 252 L 550 264 Q 550 292 604 292 L 688 292 Q 738 292 738 264 L 738 252"
        fill="none"
        stroke="#b3c2cf"
        strokeWidth="8"
        strokeLinecap="round"
      />

      {/* оси между сдвоенными колёсами */}
      <g fill="#101519">
        <rect x="152" y="299" width="80" height="14" />
        <rect x="606" y="299" width="80" height="14" />
      </g>

      {/* ================= КОЛЁСА ================= */}
      <use href="#sp-wheel" transform="translate(150 306)" />
      <use href="#sp-wheel" transform="translate(234 306)" />
      <use href="#sp-wheel" transform="translate(604 306)" />
      <use href="#sp-wheel" transform="translate(688 306)" />
      <use href="#sp-wheel" transform="translate(838 306)" />
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
