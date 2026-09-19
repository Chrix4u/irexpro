/**
 * Web UI primitives shared across the iRexPro trader application.
 */

import { ButtonHTMLAttributes, ReactNode } from 'react';
import MobileBottomNav from '@/components/mobile-bottom-nav';
import WorkspaceSidebar, { workspaceRouteTitle } from '@/components/workspace-sidebar';
import { AutoRevealAlert } from '@/components/ui/AutoRevealAlert';
// ── Button ───────────────────────────────────────────────────────────────────
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  loading?: boolean;
  children: ReactNode;
}

export function Button({ variant = 'primary', size = 'md', block, loading, children, className = '', ...rest }: ButtonProps) {
  const cls = ['btn', `btn--${variant}`, size === 'sm' && 'btn--sm', size === 'lg' && 'btn--lg', block && 'btn--block', className]
    .filter(Boolean).join(' ');
  return (
    <button className={cls} disabled={rest.disabled || loading} {...rest}>
      {loading && <span className="spinner" />}
      {children}
    </button>
  );
}

// ── Input + Label ─────────────────────────────────────────────────────────────
interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, id, className = '', ...rest }: InputProps) {
  const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);
  return (
    <div className="input-group">
      {label && <label htmlFor={inputId} className="input-label">{label}</label>}
      <input id={inputId} className={`input ${className}`} {...rest} />
      {error && <p className="alert alert--error" style={{ marginTop: '0.5rem', marginBottom: 0 }}>{error}</p>}
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────
interface CardProps { title?: string; subtitle?: string; children: ReactNode; className?: string; }

export function Card({ title, subtitle, children, className = '' }: CardProps) {
  return (
    <div className={`card ${className}`}>
      {title && <h2 className="card__title">{title}</h2>}
      {subtitle && <p className="card__subtitle">{subtitle}</p>}
      {children}
    </div>
  );
}

// ── Alert ────────────────────────────────────────────────────────────────────
type AlertVariant = 'error' | 'success' | 'warning' | 'info';

export function Alert({ variant = 'info', children }: { variant?: AlertVariant; children: ReactNode }) {
  return <AutoRevealAlert variant={variant}>{children}</AutoRevealAlert>;
}

// ── Badge ────────────────────────────────────────────────────────────────────
type BadgeVariant = 'success' | 'error' | 'warning' | 'info';

export function Badge({ variant = 'info', children }: { variant?: BadgeVariant; children: ReactNode }) {
  return <span className={`badge badge--${variant}`}>{children}</span>;
}

// ── LoadingSpinner ────────────────────────────────────────────────────────────
export function LoadingSpinner({ text = 'Loading…' }: { text?: string }) {
  return (
    <div className="text-center" style={{ padding: '2rem' }}>
      <span className="spinner" style={{ borderColor: 'var(--border)', borderTopColor: 'var(--brand)' }} />
      <p className="loading-text mt-4">{text}</p>
    </div>
  );
}

// ── EmptyState ────────────────────────────────────────────────────────────────
export function EmptyState({ icon = '📭', title, description }: { icon?: string; title: string; description?: string }) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <p className="empty-state__title">{title}</p>
      {description && <p className="muted text-sm">{description}</p>}
    </div>
  );
}

// ── AuthLayout ────────────────────────────────────────────────────────────────
interface AuthLayoutProps { title: string; subtitle?: string; children: ReactNode; }

export function AuthLayout({ title, subtitle, children }: AuthLayoutProps) {
  return (
    <div className="auth-layout">
      <div className="auth-layout__brand">
        <div className="auth-layout__brand-content">
          <div className="auth-layout__logo">
            <span className="auth-layout__logo-mark">iR</span>
            iRexPro
          </div>
          <h1 className="auth-layout__headline">AI-Powered Forex Trading Platform</h1>
          <p className="auth-layout__subheadline">
            Connect your regulated broker account and let iRexPro execute AI-driven
            trades autonomously — with mandatory risk validation on every signal.
          </p>
          <ul className="auth-layout__features">
            <li>AI signal generation with risk-gated execution</li>
            <li>High-water-mark performance fee billing</li>
            <li>Transparent performance-fee billing</li>
            <li>Encrypted broker credentials (AES-256-GCM)</li>
          </ul>
        </div>
      </div>
      <div className="auth-layout__form-side">
        <div className="auth-layout__form-container">
          <h1 style={{ marginBottom: '0.5rem' }}>{title}</h1>
          {subtitle && <p className="muted" style={{ marginBottom: '1.5rem' }}>{subtitle}</p>}
          {children}
        </div>
      </div>
    </div>
  );
}

// ── Trader workspace shell ───────────────────────────────────────────────────
interface DashboardShellProps {
  user: { email: string | null; firstName?: string | null; lastName?: string | null } | null;
  onLogout: () => void;
  activeRoute?: string;
  title?: string;
  children: ReactNode;
}

export function DashboardShell({ user, onLogout, activeRoute, title, children }: DashboardShellProps) {
  return (
    <div className="dashboard-shell terminal-shell" data-active-route={activeRoute}>
      <WorkspaceSidebar user={user} onLogout={onLogout} activeRoute={activeRoute} />

      <div className="dashboard-main terminal-main">
        <header className="dashboard-header terminal-header">
          <div>
            <span className="terminal-header__eyebrow">AI trading workspace</span>
            <span className="dashboard-header__title terminal-header__title">{title ?? workspaceRouteTitle(activeRoute)}</span>
          </div>
          <div className="terminal-header__principle" aria-label="Execution safety principle">
            AI automation · protected by server risk controls
          </div>
        </header>
        <div className="dashboard-content terminal-content">{children}</div>
      </div>

      <MobileBottomNav onLogout={onLogout} />
    </div>
  );
}
