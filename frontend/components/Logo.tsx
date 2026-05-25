interface LogoProps { size?: number; wordmark?: boolean; }
/* QuantTrade mark — stacked candlestick body with a thin wick on each
 * side, in cyan + green/red.  Reads as "trading data" at any size. */
export function Logo({ size = 28, wordmark = true }: LogoProps) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
      <svg width={size} height={size} viewBox="0 0 40 40" aria-label="QuantTrade mark">
        <rect x="2" y="2" width="36" height="36" rx="5" fill="rgb(var(--bg-soft))" stroke="rgb(var(--line))" />
        {/* Buy candle (green) */}
        <line x1="11" y1="9" x2="11" y2="14" stroke="rgb(var(--bid))" strokeWidth="1.4" />
        <rect x="9"  y="14" width="4" height="9"  fill="rgb(var(--bid))" />
        <line x1="11" y1="23" x2="11" y2="27" stroke="rgb(var(--bid))" strokeWidth="1.4" />
        {/* Sell candle (red) */}
        <line x1="20" y1="11" x2="20" y2="16" stroke="rgb(var(--ask))" strokeWidth="1.4" />
        <rect x="18" y="16" width="4" height="13" fill="rgb(var(--ask))" />
        <line x1="20" y1="29" x2="20" y2="33" stroke="rgb(var(--ask))" strokeWidth="1.4" />
        {/* Cyan trend line */}
        <line x1="27" y1="14" x2="27" y2="20" stroke="rgb(var(--cyan))" strokeWidth="1.4" />
        <rect x="25" y="20" width="4" height="7"  fill="rgb(var(--cyan))" />
        <line x1="27" y1="27" x2="27" y2="31" stroke="rgb(var(--cyan))" strokeWidth="1.4" />
      </svg>
      {wordmark ? (
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
          <span className="mono" style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.04em' }}>QuantTrade</span>
          <span className="eyebrow" style={{ fontSize: 8, marginTop: 2 }}>Platform</span>
        </div>
      ) : null}
    </div>
  );
}
