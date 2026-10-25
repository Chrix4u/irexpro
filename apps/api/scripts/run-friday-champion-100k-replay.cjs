'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');

const DEFAULT_CORPUS_ROOT =
  '/home/lightworld/research/irexpro-six-pair/341e107b0066f26b3b373e29a2329f007bda35b4/corpora';
const PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'];
const M5_LOOKBACK = 1200;

function parseArgs(argv) {
  const out = { corpusRoot: DEFAULT_CORPUS_ROOT, output: null, maxRows: null, pairs: [...PAIRS] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--corpus-root') out.corpusRoot = argv[++i];
    else if (arg === '--output') out.output = argv[++i];
    else if (arg === '--max-rows') out.maxRows = Number(argv[++i]);
    else if (arg === '--pair') out.pairs = [String(argv[++i]).toUpperCase()];
    else throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
  }
  if (out.maxRows !== null && (!Number.isInteger(out.maxRows) || out.maxRows <= 0)) {
    throw new Error('INVALID_MAX_ROWS');
  }
  for (const pair of out.pairs) if (!PAIRS.includes(pair)) throw new Error(`INVALID_PAIR:${pair}`);
  return out;
}

function requiredIndex(header, name) {
  const index = header.indexOf(name);
  if (index < 0) throw new Error(`MISSING_COLUMN:${name}`);
  return index;
}

function rowAccessors(header) {
  const names = [
    'decision_time',
    'm1_source_bar_open',
    'm1_available_at',
    'm1_close',
    'm1_spread_price',
    'm5_source_bar_open',
    'm5_available_at',
    'm5_open',
    'm5_high',
    'm5_low',
    'm5_close',
    'm5_spread_price',
  ];
  return Object.fromEntries(names.map((name) => [name, requiredIndex(header, name)]));
}

function selectedFields(parts, ix) {
  const get = (name) => parts[ix[name]]?.trim() ?? '';
  return {
    decision_time: get('decision_time'),
    m1_source_bar_open: get('m1_source_bar_open'),
    m1_available_at: get('m1_available_at'),
    m1_close: get('m1_close'),
    m1_spread_price: get('m1_spread_price'),
    m5_source_bar_open: get('m5_source_bar_open'),
    m5_available_at: get('m5_available_at'),
    m5_open: get('m5_open'),
    m5_high: get('m5_high'),
    m5_low: get('m5_low'),
    m5_close: get('m5_close'),
    m5_spread_price: get('m5_spread_price'),
  };
}

function buildM1Quote(row) {
  const decisionAt = new Date(row.decision_time);
  const availableAt = new Date(row.m1_available_at);
  const sourceOpen = new Date(row.m1_source_bar_open);
  const mid = Number(row.m1_close);
  const spread = Number(row.m1_spread_price);
  if (
    !Number.isFinite(decisionAt.getTime()) ||
    !Number.isFinite(availableAt.getTime()) ||
    !Number.isFinite(sourceOpen.getTime()) ||
    decisionAt.getTime() < availableAt.getTime() ||
    !Number.isFinite(mid) ||
    mid <= 0 ||
    !Number.isFinite(spread) ||
    spread < 0
  ) {
    throw new Error('INVALID_M1_REPLAY_ROW');
  }
  return { observedAt: decisionAt, mid, spread };
}

function summarizeBy(episodes, keyOf, expected, summarizeReplayEpisodes) {
  const groups = new Map();
  for (const episode of episodes) {
    const key = keyOf(episode);
    const group = groups.get(key) ?? [];
    group.push(episode);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => ({ key, ...summarizeReplayEpisodes(group, expected) }));
}

async function replayPair(pair, filePath, maxRows, api) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let header = null;
  let ix = null;
  let rowCount = 0;
  let lastDecisionMs = null;
  let lastM5Row = null;
  let lastM5Open = null;
  const m5Bars = [];
  const tradingDays = new Set();
  const episodes = [];
  const incompleteEpisodes = [];
  let active = null;
  const diagnostics = {
    rows: 0,
    m5Snapshots: 0,
    m5SnapshotsBlockedByActiveTrade: 0,
    scoredSides: 0,
    intrinsicallyPaperAdmittedSides: 0,
    startedEpisodes: 0,
    tieRejects: 0,
  };

  for await (const rawLine of rl) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (header === null) {
      header = line.split(',');
      ix = rowAccessors(header);
      continue;
    }
    if (!line) continue;
    rowCount += 1;
    if (maxRows !== null && rowCount > maxRows) break;
    const parts = line.split(',');
    const row = selectedFields(parts, ix);
    const quote = buildM1Quote(row);
    const decisionMs = quote.observedAt.getTime();
    if (lastDecisionMs !== null && decisionMs <= lastDecisionMs) throw new Error('NON_MONOTONIC_DECISION_TIME');
    lastDecisionMs = decisionMs;
    tradingDays.add(quote.observedAt.toISOString().slice(0, 10));
    diagnostics.rows += 1;

    if (active) {
      const advanced = api.advanceReplayPaperEpisode(active.state, quote);
      active.state = advanced.state;
      if (advanced.closed) {
        const evidence = {
          ...advanced.closed,
          strategyRoute: active.strategyRoute,
          confidence: active.confidence,
        };
        if (evidence.exitReason === 'DATA_END') incompleteEpisodes.push(evidence);
        else episodes.push(evidence);
        active = null;
      }
    }

    const m5Open = row.m5_source_bar_open;
    let newM5 = false;
    if (lastM5Open === null || m5Open !== lastM5Open) {
      if (lastM5Open !== null && Date.parse(m5Open) <= Date.parse(lastM5Open)) {
        throw new Error('NON_MONOTONIC_M5_SOURCE');
      }
      const [bar] = api.reconstructClosedM5Bars([row]);
      if (!bar) throw new Error('M5_RECONSTRUCTION_EMPTY');
      m5Bars.push(bar);
      if (m5Bars.length > M5_LOOKBACK) m5Bars.shift();
      lastM5Open = m5Open;
      lastM5Row = row;
      newM5 = true;
      diagnostics.m5Snapshots += 1;
    } else if (lastM5Row) {
      api.reconstructClosedM5Bars([lastM5Row, row]);
    }

    if (!newM5) continue;
    if (active) {
      diagnostics.m5SnapshotsBlockedByActiveTrade += 1;
      continue;
    }

    const scored = api.scoreIntrinsicM5Snapshot(pair, m5Bars);
    diagnostics.scoredSides += scored.length;
    const admitted = scored.filter((entry) => entry.ensemble.paperAdmitted);
    diagnostics.intrinsicallyPaperAdmittedSides += admitted.length;
    const selected = api.selectIntrinsicPaperSide(scored);
    if (!selected) {
      if (
        admitted.length > 1 &&
        Math.abs(admitted[0].candidate.score - admitted[1].candidate.score) <= Number.EPSILON
      ) {
        diagnostics.tieRejects += 1;
      }
      continue;
    }
    active = {
      state: api.startReplayPaperEpisode(selected.candidate, quote),
      strategyRoute: selected.ensemble.strategyRoute,
      confidence: selected.candidate.confidence,
    };
    diagnostics.startedEpisodes += 1;
  }

  if (active) {
    incompleteEpisodes.push({
      ...api.finishReplayPaperEpisode(active.state, 'DATA_END'),
      strategyRoute: active.strategyRoute,
      confidence: active.confidence,
    });
  }
  return {
    pair,
    filePath,
    tradingDays: [...tradingDays],
    episodes,
    incompleteEpisodes,
    diagnostics,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiRoot = path.resolve(__dirname, '..');
  const replay = require(path.join(apiRoot, 'dist/modules/ai/research/friday-champion-100k-replay.js'));
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.resolve(apiRoot, '..'),
    encoding: 'utf8',
  }).trim();

  const pairRuns = [];
  for (const pair of args.pairs) {
    const filePath = path.join(args.corpusRoot, `${pair}_MTF.csv`);
    if (!fs.existsSync(filePath)) throw new Error(`CORPUS_FILE_MISSING:${pair}`);
    process.stderr.write(`REPLAY_START ${pair} ${filePath}\n`);
    const run = await replayPair(pair, filePath, args.maxRows, replay);
    pairRuns.push(run);
    process.stderr.write(
      `REPLAY_DONE ${pair} rows=${run.diagnostics.rows} episodes=${run.episodes.length} incomplete=${run.incompleteEpisodes.length}\n`,
    );
  }

  const episodes = pairRuns.flatMap((run) => run.episodes);
  const tradingDays = new Set(pairRuns.flatMap((run) => run.tradingDays));
  const expectedInstruments = args.pairs.length === PAIRS.length ? PAIRS : args.pairs;
  const report = replay.buildReplayStressReport(episodes, {
    sourceCommit,
    corpusLabel: args.maxRows ? `six-pair-100k-smoke-max-${args.maxRows}` : 'six-pair-100k-frozen',
    observedTradingDays: tradingDays.size,
    expectedInstruments,
  });
  report.scope = {
    pairs: args.pairs,
    maxRowsPerPair: args.maxRows,
    m5LookbackBars: M5_LOOKBACK,
    lifecycleMarkCadence: 'M1_CLOSE_AVAILABLE_AT',
    spreadPolicy: 'MAX_CORPUS_M1_SPREAD_AND_PAPER_FALLBACK',
  };
  report.pairs = summarizeBy(episodes, (episode) => episode.instrument, expectedInstruments, replay.summarizeReplayEpisodes);
  report.sleeves = replay.summarizeReplaySleeves(episodes);
  report.routeSleeves = replay.summarizeReplayRouteSleeves(episodes);
  report.routes = summarizeBy(episodes, (episode) => episode.strategyRoute, expectedInstruments, replay.summarizeReplayEpisodes);
  report.exitReasons = Object.entries(
    episodes.reduce((acc, episode) => {
      acc[episode.exitReason] = (acc[episode.exitReason] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([exitReason, count]) => ({ exitReason, count }));
  report.diagnostics = pairRuns.map((run) => ({
    pair: run.pair,
    ...run.diagnostics,
    incompleteEpisodes: run.incompleteEpisodes.length,
  }));
  report.incompleteEpisodes = pairRuns.reduce((sum, run) => sum + run.incompleteEpisodes.length, 0);
  report.limitations = [
    'historical architecture stress replay, not pristine holdout validation',
    'prospective DB governance/calibration is not back-filled into history',
    'historical macro-event vetoes and exact streaming intra-minute marks are unavailable',
    'M1-close lifecycle marks approximate the live streaming PAPER mark path',
  ];

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) {
    fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    fs.writeFileSync(args.output, json);
    process.stdout.write(`REPLAY_REPORT_WRITTEN ${path.resolve(args.output)}\n`);
  } else {
    process.stdout.write(json);
  }
}

module.exports = { parseArgs, buildM1Quote, replayPair };

if (require.main === module) {
  main().catch((error) => {
    console.error('FRIDAY_CHAMPION_100K_REPLAY_FAILED', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
