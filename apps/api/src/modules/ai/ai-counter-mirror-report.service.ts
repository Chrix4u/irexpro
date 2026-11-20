import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile, stat } from 'node:fs/promises';

const REPORT_PATH =
  '/home/lightworld/webapps/irexpro-research/counter-direction/latest-report.json';
const MAX_REPORT_BYTES = 512_000;
const EXPECTED_ARTIFACT = 'irexpro-main-counter-pepperstone-virtual-v1';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>) : null;
}
function valueNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function finiteTime(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}
function side(value: unknown): 'BUY' | 'SELL' | null {
  return value === 'BUY' || value === 'SELL' ? value : null;
}
function money(value: unknown): number | null {
  return valueNumber(value);
}
function textValue(value: unknown, maximum = 80): string {
  return typeof value === 'string' ? value.slice(0, maximum) : '';
}

export interface CounterMirrorWebRow {
  pairId: string;
  instrument: string;
  openedAt: string;
  main: {
    label: 'MAIN';
    direction: 'BUY' | 'SELL';
    lotSize: number | null;
    state: string;
    closedAt: string | null;
    netUsd: number | null;
    openMarkEstimateNetUsd: number | null;
  };
  counter: {
    label: 'COUNTER';
    direction: 'BUY' | 'SELL';
    virtualOnly: true;
    state: string;
    matchedHorizonEstimateUsd: number | null;
    mirroredBarrierEstimateUsd: number | null;
    openMarkEstimateNetUsd: number | null;
    barrierOutcome: string;
    reason: string;
  };
}
export interface CounterMirrorWebDay {
  day: string;
  mainClosed: number;
  mainWins: number;
  mainLosses: number;
  mainNetUsd: number;
  counterComparable: number;
  counterWins: number;
  counterLosses: number;
  counterEstimatedNetUsd: number;
  pairedEstimatedNetUsd: number;
  unresolvedCounter: number;
}
export interface CounterMirrorWebReport {
  artifact: 'irexpro-main-counter-pepperstone-virtual-v1';
  generatedAt: string;
  stale: boolean;
  executionAuthority: 'NONE';
  virtualOnly: true;
  caution: string;
  daily: CounterMirrorWebDay[];
  pairs: CounterMirrorWebRow[];
}

export function projectCounterMirrorReport(
  payload: unknown,
  now = new Date(),
): CounterMirrorWebReport {
  const root = object(payload);
  if (
    !root || root.artifact !== EXPECTED_ARTIFACT ||
    root.executionAuthority !== 'NONE' || root.modifiesTrading !== false
  ) throw new Error('COUNTER_REPORT_CONTRACT_MISMATCH');
  const generatedAt = finiteTime(root.generatedAt);
  if (!generatedAt) throw new Error('COUNTER_REPORT_MISSING_TIMESTAMP');
  const ageMs = now.getTime() - new Date(generatedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < -30_000) throw new Error('COUNTER_REPORT_BAD_AGE');
  const rawPairs = Array.isArray(root.paired) ? root.paired : [];
  if (rawPairs.length > 80) throw new Error('COUNTER_REPORT_TOO_MANY_PAIRS');
  const pairs: CounterMirrorWebRow[] = [];
  for (const raw of rawPairs) {
    const p = object(raw),m = object(p?.main),c = object(p?.counter);
    if (!p || !m || !c || m.label !== 'MAIN' || c.label !== 'COUNTER' ||
        c.isBrokerOrder !== false || c.executionAuthority !== 'NONE') continue;
    const instrument = textValue(m.instrument, 12);
    const openedAt = finiteTime(m.openedAt);
    const mainDirection = side(m.direction),counterDirection = side(c.direction);
    if (!/^[A-Z]{6}$/.test(instrument) || !openedAt ||
        !mainDirection || !counterDirection ||
        mainDirection === counterDirection || c.instrument !== instrument) continue;
    pairs.push({
      pairId: textValue(p.pairId, 64),
      instrument,
      openedAt,
      main: {
        label: 'MAIN',
        direction: mainDirection,
        lotSize: valueNumber(m.lotSize),
        state: textValue(m.state, 40),
        closedAt: finiteTime(m.closedAt),
        netUsd: money(m.netUsd),
        openMarkEstimateNetUsd: money(m.openMarkEstimateNetUsd),
      },
      counter: {
        label: 'COUNTER',
        direction: counterDirection,
        virtualOnly: true,
        state: textValue(c.state, 60),
        matchedHorizonEstimateUsd: money(c.matchedHorizonNetUsd),
        mirroredBarrierEstimateUsd: money(c.mirroredBarrierNetUsd),
        openMarkEstimateNetUsd: money(c.openMarkEstimateNetUsd),
        barrierOutcome: textValue(c.barrierOutcome, 80),
        reason: textValue(c.reason, 100),
      },
    });
  }
  const rawDaily = object(root.daily) ?? {};
  const daily: CounterMirrorWebDay[] = Object.entries(rawDaily)
    .filter(([day, value]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && object(value))
    .map(([day, raw]) => {
      const d = object(raw)!;
      const count = (key: string) => Math.max(0, Math.floor(valueNumber(d[key]) ?? 0));
      return {
        day,
        mainClosed: count('mainClosed'),mainWins: count('mainWins'),
        mainLosses: count('mainLosses'),mainNetUsd: money(d.actualMainNetUsd) ?? 0,
        counterComparable: count('counterComparable'),
        counterWins: count('counterWins'),counterLosses: count('counterLosses'),
        counterEstimatedNetUsd: money(d.virtualCounterMatchedNetUsd) ?? 0,
        pairedEstimatedNetUsd: money(d.pairedNetUsd) ?? 0,
        unresolvedCounter: count('unresolvedCounter'),
      };
    })
    .sort((a,b)=>b.day.localeCompare(a.day))
    .slice(0,5);
  return {
    artifact: EXPECTED_ARTIFACT,generatedAt,
    stale: ageMs > 5*60_000,
    executionAuthority:'NONE',virtualOnly:true,
    caution:
      'MAIN uses confirmed Pepperstone DEMO executions. COUNTER is a virtual opposite-direction experiment, not a placed broker order. Counter USD returns use minute-level spread and commission estimates and do not guarantee tradable fills.',
    daily,pairs:pairs.slice(0,35),
  };
}

@Injectable()
export class AiCounterMirrorReportService {
  constructor(private readonly config: ConfigService) {}

  async getOwnerReport(userId: string): Promise<CounterMirrorWebReport> {
    const ownerId = this.config.get<string>('vpsForexScanner.userId', '').trim();
    if (!ownerId || userId !== ownerId) {
      throw new ForbiddenException('Counter experiment not available for this user');
    }
    try {
      const info = await stat(REPORT_PATH);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_REPORT_BYTES) {
        throw new Error('COUNTER_REPORT_UNAVAILABLE_OR_TOO_LARGE');
      }
      const text = await readFile(REPORT_PATH, 'utf8');
      return projectCounterMirrorReport(JSON.parse(text) as unknown);
    } catch {
      throw new ServiceUnavailableException('Counter experiment report is not ready');
    }
  }
}
