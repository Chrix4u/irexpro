const CENTER_X = 160;
const CENTER_Y = 144;
const RADIUS = 120;
const MARKS = [0, 20, 40, 60, 80, 100] as const;
// Visual score bands only. They never establish trade eligibility.
const BANDS = [
  { from: 0, to: 25, color: "#ef4444" },
  { from: 25, to: 50, color: "#f97316" },
  { from: 50, to: 70, color: "#eab308" },
  { from: 70, to: 100, color: "#22c55e" },
] as const;

function point(value: number, radius: number) {
  const angle = Math.PI * value / 100;
  return {
    x: CENTER_X - radius * Math.cos(angle),
    y: CENTER_Y - radius * Math.sin(angle),
  };
}

function arc(from: number, to: number) {
  const a = point(from, RADIUS);
  const b = point(to, RADIUS);
  return `M ${a.x} ${a.y} A ${RADIUS} ${RADIUS} 0 0 1 ${b.x} ${b.y}`;
}

/** A presentation-only dial driven by the authoritative model score. */
export function TradeReadinessDial({ score }: { score: number }) {
  const valid = Number.isFinite(score);
  const bounded = valid ? Math.max(0, Math.min(100, score)) : null;
  const angle = bounded === null ? null : -180 + bounded * 1.8;

  return (
    <svg className="ai-readiness__dial" viewBox="0 0 320 164" aria-hidden="true" focusable="false">
      {BANDS.map((band) => (
        <path key={band.from} d={arc(band.from, band.to)} stroke={band.color} strokeWidth="15" fill="none" />
      ))}
      {MARKS.map((mark) => {
        const a = point(mark, 100);
        const b = point(mark, 108);
        const label = point(mark, 86);
        return (
          <g key={mark}>
            <line className="ai-readiness__tick" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            <text className="ai-readiness__tick-label" x={label.x} y={label.y} textAnchor="middle" dominantBaseline="central">{mark}</text>
          </g>
        );
      })}
      {angle !== null ? (
        <g className="ai-readiness__dial-needle" style={{ transform: `rotate(${angle}deg)` }}>
          <path d="M 150 140 L 260 144 L 150 148 Z" fill="currentColor" />
        </g>
      ) : null}
      <circle className="ai-readiness__dial-hub" cx={CENTER_X} cy={CENTER_Y} r="6" />
    </svg>
  );
}
