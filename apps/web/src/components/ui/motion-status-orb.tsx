'use client';

export type MotionStatusTone = 'success' | 'info' | 'warning' | 'error' | 'neutral';

const TONES: Record<MotionStatusTone, string> = {
  success: '#22c55e',
  info: '#38bdf8',
  warning: '#f59e0b',
  error: '#ef4444',
  neutral: '#64748b',
};

export function MotionStatusOrb({
  tone = 'neutral',
  active = true,
  label,
}: {
  tone?: MotionStatusTone;
  active?: boolean;
  label?: string;
}) {
  const color = TONES[tone];
  return (
    <span
      className="motion-status-orb"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ '--motion-status-color': color } as React.CSSProperties}
    >
      <span className="motion-status-orb__halo" data-active={active ? 'true' : 'false'} />
      <span className="motion-status-orb__core" />
      <style jsx>{`
        .motion-status-orb { position: relative; display: inline-grid; place-items: center; width: 1rem; height: 1rem; flex: 0 0 1rem; }
        .motion-status-orb__core, .motion-status-orb__halo { position: absolute; width: .55rem; height: .55rem; border-radius: 999px; background: var(--motion-status-color); }
        .motion-status-orb__core { box-shadow: 0 0 0 3px color-mix(in srgb, var(--motion-status-color) 14%, transparent), 0 0 18px color-mix(in srgb, var(--motion-status-color) 42%, transparent); }
        .motion-status-orb__halo[data-active='true'] { animation: statusRipple 1.8s ease-out infinite; }
        .motion-status-orb__halo[data-active='false'] { opacity: .25; }
        @keyframes statusRipple { 0% { transform: scale(.8); opacity: .48; } 75%, 100% { transform: scale(2.45); opacity: 0; } }
        @media (prefers-reduced-motion: reduce) { .motion-status-orb__halo { animation: none !important; opacity: .25; } }
      `}</style>
    </span>
  );
}
