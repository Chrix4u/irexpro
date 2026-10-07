export const V8_SHADOW_ARTIFACT = 'v8-shadow-online-meta-v1';
export const V8_SHADOW_MODE = 'PROSPECTIVE_SHADOW_ONLY';
export const V8_SHADOW_ADMISSION_THRESHOLD = 0.46;
export const V8_SHADOW_TARGET_R_MULTIPLE = 2.5 / 1.5;
export const PLAN_B_SHADOW_ARTIFACT = 'plan-b-online-meta-v1';
export const PLAN_B_SHADOW_MODE = 'PROSPECTIVE_SHADOW_ONLY';
export const PLAN_B_SHADOW_ADMISSION_THRESHOLD = 0.40828402366863903;

export interface V8ShadowMetaInput {
  instrument: string;
  direction: 'BUY' | 'SELL';
  confidence: number;
  extensionAtr: number;
  volatilityScore: number;
  emaSeparation: number;
  mtfStrength: number;
  rsi14: number;
  shortHorizonMomentumAtr?: number;
  scanTime: Date;
}

export interface PlanBShadowMetaScore {
  artifact: typeof PLAN_B_SHADOW_ARTIFACT;
  mode: typeof PLAN_B_SHADOW_MODE;
  probability: number;
  admissionThreshold: number;
  expectedR: number;
  admitted: boolean;
  reason: 'ADMIT' | 'REJECT_EXPECTED_VALUE';
}

export interface V8ShadowMetaScore {
  artifact: typeof V8_SHADOW_ARTIFACT;
  mode: typeof V8_SHADOW_MODE;
  probability: number;
  admissionThreshold: number;
  expectedR: number;
  admitted: boolean;
  reason: 'ADMIT' | 'REJECT_EXPECTED_VALUE';
}

const BASE_WEIGHTS: Record<string, number> = Object.freeze({
  bias: -0.11578161968250648,
  confidence: 0.17961055475997342,
  ema: 0.2708431513544996,
  extension: 0.1151803622647996,
  hour_cos: -0.15313534925717265,
  hour_sin: 0.215165154794897,
  mtf: -0.3645333135056978,
  rsi_strength: -0.047043617511801646,
  side_BUY: -0.0492200649488142,
  side_SELL: -0.04408451035852483,
  sym_AUDUSD: -0.06265012373206902,
  sym_EURUSD: 0.039099242595638996,
  sym_GBPUSD: -0.1548319088627653,
  sym_USDCAD: 0.32702887788665214,
  sym_USDCHF: -0.15448575884341276,
  sym_USDJPY: -0.10620810348194867,
  ps_AUDUSD_BUY: 0.01305869144342724,
  ps_AUDUSD_SELL: -0.07631086969446096,
  ps_EURUSD_BUY: 0.09263580825761873,
  ps_EURUSD_SELL: -0.05360183633069556,
  ps_GBPUSD_BUY: -0.10808016199943021,
  ps_GBPUSD_SELL: -0.047992133392960365,
  ps_USDCAD_BUY: 0.008070580817087548,
  ps_USDCAD_SELL: 0.31933167577784016,
  ps_USDCHF_BUY: -0.09518244851847857,
  ps_USDCHF_SELL: -0.060323651816662834,
  ps_USDJPY_BUY: 0.03126335181044257,
  ps_USDJPY_SELL: -0.1376652746435702,
  volatility: 0.029796295461264378,
});

function sigmoid(value: number): number {
  if (value >= 30) return 1;
  if (value <= -30) return 0;
  return 1 / (1 + Math.exp(-value));
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`v8 shadow ${name} must be finite`);
  return value;
}

export function scoreV8ShadowMeta(input: V8ShadowMetaInput): V8ShadowMetaScore {
  const instrument = input.instrument.trim().toUpperCase();
  if (!['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'].includes(instrument)) {
    throw new Error(`v8 shadow unsupported instrument ${input.instrument}`);
  }

  const confidence = finite(input.confidence, 'confidence');
  const extensionAtr = finite(input.extensionAtr, 'extensionAtr');
  const volatilityScore = finite(input.volatilityScore, 'volatilityScore');
  const emaSeparation = finite(input.emaSeparation, 'emaSeparation');
  const mtfStrength = finite(input.mtfStrength, 'mtfStrength');
  const rsi14 = finite(input.rsi14, 'rsi14');
  const scanTime = new Date(input.scanTime);
  if (!Number.isFinite(scanTime.getTime())) throw new Error('v8 shadow scanTime must be valid');

  const rsiStrength = input.direction === 'BUY' ? rsi14 - 50 : 50 - rsi14;
  const hour = scanTime.getUTCHours();

  const features: Record<string, number> = {
    bias: 1,
    confidence: (confidence - 0.7) / 0.08,
    extension: (extensionAtr - 0.75) / 0.75,
    volatility: (volatilityScore - 0.375) / 0.375,
    ema: (emaSeparation - 0.5) / 0.5,
    mtf: (mtfStrength - 0.5) / 0.5,
    rsi_strength: (rsiStrength - 11) / 11,
    hour_sin: Math.sin((2 * Math.PI * hour) / 24),
    hour_cos: Math.cos((2 * Math.PI * hour) / 24),
    [`side_${input.direction}`]: 1,
    [`sym_${instrument}`]: 1,
    [`ps_${instrument}_${input.direction}`]: 1,
  };

  const logit = Object.entries(features).reduce(
    (sum, [key, value]) => sum + (BASE_WEIGHTS[key] ?? 0) * value,
    0,
  );
  const probability = sigmoid(logit);
  const expectedR = probability * V8_SHADOW_TARGET_R_MULTIPLE - (1 - probability);
  const admitted = probability >= V8_SHADOW_ADMISSION_THRESHOLD;

  return {
    artifact: V8_SHADOW_ARTIFACT,
    mode: V8_SHADOW_MODE,
    probability,
    admissionThreshold: V8_SHADOW_ADMISSION_THRESHOLD,
    expectedR,
    admitted,
    reason: admitted ? 'ADMIT' : 'REJECT_EXPECTED_VALUE',
  };
}

export function scorePlanBShadowMeta(input: V8ShadowMetaInput): PlanBShadowMetaScore {
  const base = scoreV8ShadowMeta(input);
  const admitted = base.probability >= PLAN_B_SHADOW_ADMISSION_THRESHOLD;
  return {
    artifact: PLAN_B_SHADOW_ARTIFACT,
    mode: PLAN_B_SHADOW_MODE,
    probability: base.probability,
    admissionThreshold: PLAN_B_SHADOW_ADMISSION_THRESHOLD,
    expectedR: base.expectedR,
    admitted,
    reason: admitted ? 'ADMIT' : 'REJECT_EXPECTED_VALUE',
  };
}
