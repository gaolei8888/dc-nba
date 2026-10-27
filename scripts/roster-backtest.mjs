#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateExperiment } from '../server/rosterReplay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Usage: npm run backtest:roster -- --input <dataset.json> [--json]\n'
  + '       npm run backtest:roster -- --audit [--data-dir <directory>] [--json]';

function audit(dataDir) {
  const history = path.join(dataDir, 'history');
  const files = fs.existsSync(history) ? fs.readdirSync(history) : [];
  const datasetFile = path.join(dataDir, 'roster-experiment.json');
  const exists = fs.existsSync(datasetFile);
  const missing = exists ? [] : [
    'A dated opening roster snapshot for every team/season with source and availableAt',
    'Dated projected minutes, availability, and impact (or explicit sourced priors) for all rotation players',
    'Complete official game logs with predictionAt/resultAt and final scores',
    'Preseason Elo, pace, legacy adjustment, and prior-season player minutes known at opening',
    'Sourced home/rest/spread/Elo-K calibration available before the first training season',
    'A schemaVersion 1 dataset declaring training seasons and an untouched chronological holdout',
  ];
  return {
    ready: false, dataDir, datasetFile, datasetFound: exists,
    inventory: {
      stintSeasons: files.filter((f) => /^stints_.*\.json(?:\.gz)?$/.test(f)),
      gameLogs: files.filter((f) => /^gamelog_.*\.json$/.test(f)),
      impactInputs: files.filter((f) => /^impact_.*\.json$/.test(f)),
      currentTeamData: fs.existsSync(path.join(dataDir, 'teams.json')),
    }, missing,
    nextStep: exists ? `Validate the dated dataset with --input ${datasetFile}`
      : 'Prepare dated inputs following docs/roster-experiment-inputs.md, then run --input <dataset.json>',
    limitation: 'Stints and full-season roster lists cannot reconstruct historical preseason forecasts. No network requests were made.',
  };
}

const number = (n) => n == null ? '—' : n.toFixed(5);
function renderGroup(label, group) {
  const lines = [`\n${label}: ${group.n} games`, 'Model          Log loss     Brier       Margin MAE'];
  for (const [key, name] of [['baseline', 'Rolling Elo'], ['legacy', 'Legacy IMP'], ['candidate', 'Roster blend']]) {
    const s = group[key];
    lines.push(`${name.padEnd(14)} ${number(s?.logLoss).padEnd(12)} ${number(s?.brier).padEnd(11)} ${number(s?.mae)}`);
  }
  for (const pair of [group.paired, group.pairedLegacy]) {
    if (!pair) continue;
    lines.push(`Candidate minus ${pair.reference} (negative is better): log loss ${number(pair.difference.logLoss)}, `
      + `Brier ${number(pair.difference.brier)}, MAE ${number(pair.difference.mae)}`);
    lines.push(`95% paired season-block bootstrap intervals (${pair.seasons} seasons): `
      + (pair.interval95 ? Object.entries(pair.interval95).map(([k, v]) => `${k} [${v.map(number).join(', ')}]`).join('; ')
        : 'omitted: fewer than two season blocks'));
  }
  return lines;
}

function render(report) {
  const lines = [`${report.kind.toUpperCase()} roster experiment — production rankings unchanged`,
    ...report.warnings.map((w) => `WARNING: ${w}`),
    `Training: ${report.trainingSeasons.join(', ')}; holdout: ${report.holdoutSeasons.join(', ')}`,
    `Selected roster blend: ${report.selectedBlend}; training log loss chooses the weight`,
    `Shared settings: home ${report.parameters.homeAdv}, rest ${report.parameters.restWeight}, `
      + `spread SD ${report.parameters.spreadSd}, Elo K ${report.parameters.k}`,
    `High turnover: departing share of prior-season minutes >= ${report.highTurnoverThreshold}`,
    '\nTraining candidates (not holdout performance):',
    ...report.training.map((r) => `  blend ${r.blend}: log loss ${number(r.logLoss)} (${r.n} games)`),
    ...renderGroup('Holdout: all', report.holdout.all),
    ...renderGroup('Early season (either team <10 prior games)', report.holdout.early),
    ...renderGroup('High-turnover matchups', report.holdout.highTurnover),
  ];
  for (const s of report.holdout.seasons) lines.push(...renderGroup(s.season, s));
  lines.push('\nInput coverage (prior minutes = minutes using explicit impact priors):');
  for (const s of report.coverage) {
    lines.push(`  ${s.season}: ${s.games} games, ${s.teams.length} teams, ${s.excludedSnapshots} future snapshots excluded`);
    for (const t of s.teams) lines.push(`    Team ${t.teamId}: prior minutes ${number(t.priorMinutes)}/240, `
      + `departures ${(100 * t.departureShare).toFixed(1)}%, roster ${number(t.rosterPoints)} points/game`);
  }
  lines.push('\nNo automatic model promotion. Review held-out evidence before changing production defaults.');
  return lines.join('\n');
}

try {
  const args = process.argv.slice(2); let input; let json = false; let auditOnly = false; let dataDir;
  const used = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (used.has(arg)) throw new Error(`Duplicate option ${arg}`);
    used.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--audit') auditOnly = true;
    else if (arg === '--input' || arg === '--data-dir') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      const value = args[++i];
      if (arg === '--input') input = value; else dataDir = value;
    } else throw new Error(`Unknown option ${arg}`);
  }
  if (input && (auditOnly || dataDir)) throw new Error('--input cannot be combined with --audit or --data-dir');
  if (!input) {
    const report = audit(path.resolve(dataDir ?? path.join(root, 'data')));
    console.log(json ? JSON.stringify(report, null, 2)
      : ['Real-data audit: no accuracy comparison performed',
        `Data directory: ${report.dataDir}`,
        `Available: ${report.inventory.stintSeasons.length} stint seasons; ${report.inventory.gameLogs.length} cached game logs; `
          + `${report.inventory.impactInputs.length} impact input seasons`,
        ...report.missing.map((s) => `Missing: ${s}`), report.nextStep, report.limitation].join('\n'));
    process.exitCode = report.datasetFound ? 0 : 2;
  } else {
    const report = evaluateExperiment(JSON.parse(fs.readFileSync(path.resolve(input), 'utf8')));
    console.log(json ? JSON.stringify(report, null, 2) : render(report));
  }
} catch (error) {
  console.error(`Roster experiment: ${error.message}\n${usage}`);
  process.exitCode = 2;
}
