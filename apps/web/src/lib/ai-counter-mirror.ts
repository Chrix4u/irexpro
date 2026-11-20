import { api } from '@/lib/api';

export interface CounterMirrorDayView {
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

export interface CounterMirrorRowView {
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
export interface CounterMirrorReportView {
  artifact: 'irexpro-main-counter-pepperstone-virtual-v1';
  generatedAt: string;
  stale: boolean;
  executionAuthority: 'NONE';
  virtualOnly: true;
  caution: string;
  daily: CounterMirrorDayView[];
  pairs: CounterMirrorRowView[];
}
function obj(x: unknown): Record<string, unknown> | null {
  return x && typeof x === 'object' && !Array.isArray(x)
    ? x as Record<string, unknown> : null;
}
function valid(x: unknown): x is CounterMirrorReportView {
  const root=obj(x);
  if(!root||root.artifact!=='irexpro-main-counter-pepperstone-virtual-v1'||
    root.executionAuthority!=='NONE'||root.virtualOnly!==true||
    typeof root.stale!=='boolean'||typeof root.generatedAt!=='string'||
    typeof root.caution!=='string'||!Array.isArray(root.daily)||
    !Array.isArray(root.pairs))return false;
  return root.pairs.every(raw=>{
    const pair=obj(raw),main=obj(pair?.main),counter=obj(pair?.counter);
    return pair&&main&&counter&&main.label==='MAIN'&&counter.label==='COUNTER'&&
      counter.virtualOnly===true&&typeof pair.instrument==='string'&&
      ((main.direction==='BUY'&&counter.direction==='SELL')||
       (main.direction==='SELL'&&counter.direction==='BUY'));
  })===true;
}
export async function loadCounterMirrorReport():Promise<CounterMirrorReportView>{
  const raw=await api.request<unknown>('/ai/counter-mirror');
  if(!valid(raw))throw new Error('Counter mirror report contract mismatch');
  return raw;
}
