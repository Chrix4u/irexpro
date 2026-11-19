import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { M1TacticalEvidenceService } from './m1-tactical-evidence.service';
import type { M1PortfolioNetLossBrakeDecision } from './m1-portfolio-net-loss-brake';

export const DEMO_PORTFOLIO_BRAKE_CONSENT_ARTIFACT =
  'pepperstone-owner-demo-portfolio-brake-consent-v1' as const;
export const DEMO_PORTFOLIO_BRAKE_RISK_ACKNOWLEDGMENT =
  'I understand that continuing DEMO trading during a loss-streak pause may cause additional losses.' as const;
const PAUSE_MS = 120 * 60_000;

interface ExactOwnerSession {
  session_id: string;
  broker_connection_id: string;
}
interface BrokerClosedRecord {
  closed_at: Date | string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  realised_pnl: string | number | null;
  commission: string | number | null;
  swap: string | number | null;
}

export interface DemoPortfolioBrakeStatus {
  supported: boolean;
  state: 'UNAVAILABLE' | 'CLEAR' | 'PAUSED' | 'WAITING' | 'OVERRIDDEN' | 'ADVISORY';
  active: boolean;
  requiresOwnerDecision: boolean;
  resumeAuthorized: boolean;
  userDecision: 'RESUME' | 'KEEP_PAUSED' | null;
  incidentClosedAt: string | null;
  brakeExpiresAt: string | null;
  remainingSeconds: number;
  consecutiveNetLosses: number;
  lastThreeNetUsd: number | null;
  recentLosses: { closedAt: string; instrument: string; direction: string; netUsd: number }[];
  reason: string;
  brokerAccountType: 'DEMO' | null;
  currency: 'USD' | null;
  canOverrideCurrentIncident: boolean;
  otherRiskChecksRemainActive: true;
}

function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function money(value: number): number {
  return Math.round(value * 100) / 100;
}
function netFromClosedTrade(row: BrokerClosedRecord): number | null {
  const gross = parseNumber(row.realised_pnl);
  const fee = parseNumber(row.commission);
  const swap = parseNumber(row.swap);
  if (gross === null || fee === null || swap === null) return null;
  return money(gross - Math.abs(fee) + swap);
}
export function isAuthorizedBrakeIncident(
  brake: M1PortfolioNetLossBrakeDecision,
  consent: { decision: string; expires_at: Date | string } | null,
  now: Date,
): boolean {
  if (brake.active !== true ||
      brake.reason !== 'RECENT_PORTFOLIO_NET_LOSS_STREAK' ||
      brake.consecutiveNetLosses < 3 ||
      !brake.latestClosedAt ||
      !consent ||
      consent.decision !== 'RESUME') return false;
  const lastClosed = new Date(brake.latestClosedAt).getTime();
  const expiration = new Date(consent.expires_at).getTime();
  const current = now.getTime();
  return Number.isFinite(lastClosed) && Number.isFinite(expiration) &&
    Number.isFinite(current) &&
    current >= lastClosed &&
    expiration === lastClosed + PAUSE_MS &&
    current < expiration;
}

@Injectable()
export class DemoPortfolioBrakeConsentService {
  constructor(
    private readonly db: DataSource,
    private readonly config: ConfigService,
    private readonly evidence: M1TacticalEvidenceService,
  ) {}

  private ownerScope(userId: string): boolean {
    const configured = this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', '');
    return Boolean(configured && configured === userId);
  }

  private async activeOwnerDemo(userId: string): Promise<ExactOwnerSession | null> {
    if (!this.ownerScope(userId)) return null;
    const rows = (await this.db.query(
      `SELECT s.id AS session_id, s.broker_connection_id
       FROM trading.trading_sessions s
       JOIN broker.broker_connections b ON b.id=s.broker_connection_id
          AND b.user_id=s.user_id
       WHERE s.user_id=$1 AND s.status='ACTIVE'
          AND s.execution_mode='FULL_AUTO'
          AND b.broker_id='pepperstone-ctrader'
          AND b.account_type='DEMO' AND b.account_currency='USD'
          AND b.deleted_at IS NULL
       ORDER BY s.started_at DESC LIMIT 1`,
      [userId],
    )) as ExactOwnerSession[];
    return rows[0] ?? null;
  }

  private async readBrake(
    userId: string,
    session: ExactOwnerSession,
    now: Date,
  ): Promise<M1PortfolioNetLossBrakeDecision> {
    return this.evidence.loadPortfolioNetLossStreakBrake({
      userId,
      brokerConnectionId: session.broker_connection_id,
      tradingSessionId: session.session_id,
      evaluatedAt: now,
    });
  }

  private async lastConsent(
    userId: string,
    session: ExactOwnerSession,
    incident: Date,
  ): Promise<{ decision: string; expires_at: Date | string } | null> {
    const rows = (await this.db.query(
      `SELECT c.decision,c.expires_at
       FROM trading.demo_portfolio_brake_consents c
       JOIN trading.trading_sessions s ON s.id=c.trading_session_id
          AND s.user_id=c.user_id AND s.broker_connection_id=c.broker_connection_id
          AND s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'
       JOIN broker.broker_connections b ON b.id=c.broker_connection_id
          AND b.user_id=c.user_id
          AND b.broker_id='pepperstone-ctrader'
          AND b.account_type='DEMO' AND b.account_currency='USD'
          AND b.deleted_at IS NULL
       WHERE c.user_id=$1 AND c.broker_connection_id=$2
          AND c.trading_session_id=$3 AND c.incident_closed_at=$4::timestamptz
       ORDER BY c.created_at DESC,c.id DESC LIMIT 1`,
      [userId, session.broker_connection_id, session.session_id, incident.toISOString()],
    )) as Array<{ decision: string; expires_at: Date | string }>;
    return rows[0] ?? null;
  }

  /** Used by the scanner ONLY when the verified broker loss brake is already active. */
  async isOverrideActive(input: {
    userId: string;
    brokerConnectionId: string;
    sessionId: string;
    latestClosedAt: Date;
    evaluatedAt?: Date;
  }): Promise<boolean> {
    if (!this.ownerScope(input.userId)) return false;
    const now = input.evaluatedAt ?? new Date();
    const closed = new Date(input.latestClosedAt);
    if (!Number.isFinite(closed.getTime()) ||
        now.getTime() < closed.getTime() ||
        now.getTime() >= closed.getTime() + PAUSE_MS) return false;
    const session = await this.activeOwnerDemo(input.userId);
    if (!session ||
        session.broker_connection_id !== input.brokerConnectionId ||
        session.session_id !== input.sessionId) return false;
    const consent = await this.lastConsent(input.userId, session, closed);
    return consent?.decision === 'RESUME' &&
      new Date(consent.expires_at).getTime() === closed.getTime() + PAUSE_MS &&
      new Date(consent.expires_at).getTime() > now.getTime();
  }

  async getStatus(userId: string, now = new Date()): Promise<DemoPortfolioBrakeStatus> {
    const empty: DemoPortfolioBrakeStatus = {
      supported: false,
      state: 'UNAVAILABLE',
      active: false,
      requiresOwnerDecision: false,
      resumeAuthorized: false,
      userDecision: null,
      incidentClosedAt: null,
      brakeExpiresAt: null,
      remainingSeconds: 0,
      consecutiveNetLosses: 0,
      lastThreeNetUsd: null,
      recentLosses: [],
      reason: 'This owner-specific DEMO portfolio control is not available for the selected trading session.',
      brokerAccountType: null,
      currency: null,
      canOverrideCurrentIncident: false,
      otherRiskChecksRemainActive: true,
    };
    const session = await this.activeOwnerDemo(userId);
    if (!session) return empty;
    const advisoryOnly =
      this.ownerScope(userId) &&
      this.config.get<string>('IREXPRO_OWNER_DEMO_LOSS_PAUSES_ADVISORY_ONLY','')==='enabled';
    const brake = await this.readBrake(userId, session, now);
    const hasIncident = brake.active === true &&
      brake.reason === 'RECENT_PORTFOLIO_NET_LOSS_STREAK' &&
      brake.consecutiveNetLosses >= 3 &&
      brake.latestClosedAt !== null;
    const latestClosedAt = brake.latestClosedAt ? new Date(brake.latestClosedAt) : null;
    const consent = !advisoryOnly && hasIncident && latestClosedAt
      ? await this.lastConsent(userId, session, latestClosedAt)
      : null;
    const override = hasIncident && latestClosedAt
      ? isAuthorizedBrakeIncident(brake, consent, now)
      : false;

    const recent = hasIncident
      ? (await this.db.query(
        `SELECT t.closed_at,t.instrument,t.direction,
                t.realised_pnl,t.commission,t.swap
         FROM trading.trades t
         JOIN trading.trading_sessions s ON s.id=t.trading_session_id
            AND s.user_id=t.user_id AND s.broker_connection_id=t.broker_connection_id
         WHERE t.user_id=$1 AND t.broker_connection_id=$2
            AND s.execution_mode='FULL_AUTO'
            AND t.account_currency='USD'
            AND t.status='CLOSED' AND t.closed_at<= $3::timestamptz
            AND t.closed_at > ($3::timestamptz - interval '6 hours')
         ORDER BY t.closed_at DESC,t.id DESC LIMIT 3`,
        [userId, session.broker_connection_id, now.toISOString()],
      )) as BrokerClosedRecord[]
      : [];
    const losses = recent
      .map((row) => ({ closedAt: new Date(row.closed_at).toISOString(),
        instrument: row.instrument, direction: row.direction, netUsd: netFromClosedTrade(row) }))
      .filter((row): row is { closedAt: string; instrument: string; direction: 'BUY' | 'SELL'; netUsd: number } =>
        row.netUsd !== null);
    const expiresAt = latestClosedAt && hasIncident
      ? new Date(latestClosedAt.getTime() + PAUSE_MS).toISOString() : null;
    const sum = losses.length === 3
      ? money(losses.reduce((s, x) => s + x.netUsd, 0)) : null;

    return {
      ...empty,
      supported: true,
      state: !brake.active ? 'CLEAR'
        : !hasIncident ? 'UNAVAILABLE'
          : advisoryOnly ? 'ADVISORY'
          : override ? 'OVERRIDDEN'
            : consent?.decision === 'KEEP_PAUSED' ? 'WAITING'
              : 'PAUSED',
      active: brake.active,
      requiresOwnerDecision: !advisoryOnly && hasIncident && !override && !consent,
      resumeAuthorized: override,
      userDecision: consent?.decision === 'RESUME' || consent?.decision === 'KEEP_PAUSED'
        ? consent.decision : null,
      incidentClosedAt: hasIncident ? latestClosedAt!.toISOString() : null,
      brakeExpiresAt: expiresAt,
      remainingSeconds: hasIncident && expiresAt
        ? Math.max(0, Math.ceil((Date.parse(expiresAt) - now.getTime()) / 1000)) : 0,
      consecutiveNetLosses: brake.consecutiveNetLosses,
      lastThreeNetUsd: sum,
      recentLosses: losses,
      reason: hasIncident
        ? advisoryOnly
          ? 'Three net DEMO losses detected. AI Trader does not pause automatically; use Stop Trading to stop.'
          : 'Three consecutive net DEMO losses triggered a two-hour portfolio-wide new-entry pause.'
        : brake.active
          ? 'Portfolio risk evidence is unavailable; entries remain protected.'
          : 'No active portfolio loss-streak pause.',
      brokerAccountType: 'DEMO',
      currency: 'USD',
      canOverrideCurrentIncident: hasIncident && !advisoryOnly,
    };
  }

  async decide(
    userId: string,
    input: { action: 'RESUME' | 'KEEP_PAUSED'; acknowledged: boolean; incidentClosedAt: string },
  ): Promise<DemoPortfolioBrakeStatus> {
    if (input.action !== 'RESUME' && input.action !== 'KEEP_PAUSED') {
      throw new BadRequestException('Invalid portfolio brake choice.');
    }
    if (input.action === 'RESUME' && input.acknowledged !== true) {
      throw new BadRequestException('You must explicitly acknowledge the additional-loss risk.');
    }
    if (!Number.isFinite(Date.parse(input.incidentClosedAt)) ||
        new Date(input.incidentClosedAt).toISOString() !== input.incidentClosedAt) {
      throw new BadRequestException('Invalid portfolio brake incident.');
    }
    const session = await this.activeOwnerDemo(userId);
    if (!session) throw new ForbiddenException('Only the owner of the active Pepperstone USD DEMO session may choose.');
    if (this.ownerScope(userId) &&
        this.config.get<string>('IREXPRO_OWNER_DEMO_LOSS_PAUSES_ADVISORY_ONLY','')==='enabled')
      throw new BadRequestException('Portfolio cooldown decisions are retired. Use Start Trading or Stop Trading.');
    const now = new Date();
    const brake = await this.readBrake(userId, session, now);
    if (brake.active !== true ||
        brake.reason !== 'RECENT_PORTFOLIO_NET_LOSS_STREAK' ||
        brake.consecutiveNetLosses < 3 ||
        !brake.latestClosedAt) {
      throw new NotFoundException('The current loss-streak pause has ended or is unavailable.');
    }
    const latestClosedAt = new Date(brake.latestClosedAt);
    if (latestClosedAt.toISOString() !== input.incidentClosedAt) {
      throw new BadRequestException('The pause has changed. Refresh the notice and review the new losses.');
    }
    const expiry = new Date(latestClosedAt.getTime() + PAUSE_MS);
    if (expiry.getTime() <= now.getTime()) {
      throw new BadRequestException('This pause has already ended.');
    }
    const rows = (await this.db.query(
      `SELECT t.realised_pnl,t.commission,t.swap
       FROM trading.trades t
       JOIN trading.trading_sessions s ON s.id=t.trading_session_id
          AND s.user_id=t.user_id AND s.broker_connection_id=t.broker_connection_id
       WHERE t.user_id=$1 AND t.broker_connection_id=$2
          AND s.execution_mode='FULL_AUTO' AND t.status='CLOSED'
          AND t.account_currency='USD' AND t.closed_at <=$3::timestamptz
          AND t.closed_at>($3::timestamptz-interval '6 hours')
       ORDER BY t.closed_at DESC,t.id DESC LIMIT 3`,
      [userId,session.broker_connection_id,now.toISOString()],
    )) as BrokerClosedRecord[];
    const amounts = rows.map(netFromClosedTrade);
    if (amounts.length !== 3 || amounts.some(x => x === null || x >= 0)) {
      throw new BadRequestException('Cannot verify the current three-loss incident; continuing is not permitted.');
    }
    const negativeTotal = money((amounts as number[]).reduce((s, x) => s + x, 0));
    await this.db.query(
      `INSERT INTO trading.demo_portfolio_brake_consents
        (user_id,broker_connection_id,trading_session_id,incident_closed_at,
         decision,risk_acknowledged,consecutive_net_losses,losses_net_usd,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        userId,session.broker_connection_id,session.session_id,
        latestClosedAt.toISOString(),input.action,
        input.action==='RESUME' && input.acknowledged===true,
        brake.consecutiveNetLosses,negativeTotal,expiry.toISOString(),
      ],
    );
    return this.getStatus(userId);
  }
}
