/** Offline offseason experiment; deliberately not imported by production routes. */
import { computeElo, ELO_BASE, ELO_PER_POINT } from './ratings.mjs';
import { projectRotation, rosterRating } from './rosterProjection.mjs';

const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const source = (s) => typeof s === 'string' && s.trim().length > 0;
const id = (v) => Number.isSafeInteger(v) && v > 0;
function timestamp(value, label) {
  requireThat(typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
    && Number.isFinite(Date.parse(value)), `Invalid timestamp ${label}: timezone required`);
  return Date.parse(value);
}

function prepare(dataset) {
  requireThat(dataset?.schemaVersion === 1, 'Expected schemaVersion 1');
  requireThat(['synthetic', 'historical', 'exploratory'].includes(dataset.kind), 'Invalid dataset kind');
  requireThat(dataset.rosterMode === 'opening'
    || (dataset.rosterMode === 'full-season' && dataset.kind === 'exploratory'),
  'Full-season rosters must be labelled exploratory; use opening snapshots for validation');
  requireThat(finite(dataset.highTurnoverThreshold) && dataset.highTurnoverThreshold > 0
    && dataset.highTurnoverThreshold <= 1, 'Predeclare highTurnoverThreshold in (0,1]');
  requireThat(Array.isArray(dataset.seasons) && dataset.seasons.length >= 2, 'Need at least two complete seasons');
  const usedSeasons = new Set();
  let lastOpening = -Infinity;
  let lastYear;
  return dataset.seasons.map((s, seasonIndex) => {
    requireThat(/^\d{4}-\d{2}$/.test(s.season) && !usedSeasons.has(s.season), 'Invalid or duplicate season');
    const year = Number(s.season.slice(0, 4));
    requireThat(Number(s.season.slice(5)) === (year + 1) % 100
      && (lastYear == null || year === lastYear + 1), 'Seasons must be consecutive and ordered');
    usedSeasons.add(s.season); lastYear = year;
    const opening = timestamp(s.openingAt, `${s.season} openingAt`);
    requireThat(opening > lastOpening, 'Season opening times must increase'); lastOpening = opening;
    requireThat(s.complete === true && Number.isSafeInteger(s.expectedGames) && s.expectedGames > 0
      && s.games?.length === s.expectedGames, `${s.season}: incomplete schedule; expectedGames must match complete game logs`);
    requireThat(source(s.source), `${s.season}: game log source required`);
    requireThat(Array.isArray(s.teams) && s.teams.length >= 2
      && (dataset.kind !== 'historical' || s.teams.length === 30), `${s.season}: supply the complete league (30 historical NBA teams)`);
    requireThat(Array.isArray(s.snapshots), `${s.season}: dated roster snapshots required`);
    const teams = new Map();
    const rosterIds = new Set();
    let excludedSnapshots = 0;
    for (const t of s.teams) {
      requireThat(id(t.teamId) && !teams.has(t.teamId), 'Invalid or duplicate teamId');
      const p = t.prior;
      requireThat(p && source(p.source) && timestamp(p.availableAt, 'prior availableAt') <= opening,
        `${s.season}/${t.teamId}: prior inputs must be available before opening`);
      requireThat(finite(p.eloStart) && finite(p.pace) && p.pace > 0 && finite(p.turnoverAdj),
        `${s.season}/${t.teamId}: finite eloStart, positive pace and legacy turnoverAdj required`);
      requireThat(Array.isArray(p.players) && p.players.length > 0, 'Prior-season player minutes required');
      const priorIds = new Set(); let priorMinutes = 0;
      for (const row of p.players) {
        requireThat(id(row.playerId) && !priorIds.has(row.playerId) && finite(row.minutes) && row.minutes >= 0,
          'Invalid or duplicate prior-season player minutes');
        priorIds.add(row.playerId); priorMinutes += row.minutes;
      }
      requireThat(priorMinutes > 0, 'Prior-season minutes must have positive total');
      const snapshots = s.snapshots.filter((r) => r.teamId === t.teamId);
      const admissible = snapshots.filter((r) => {
        const allowed = timestamp(r.availableAt, 'snapshot availableAt') <= opening
          && timestamp(r.effectiveAt, 'snapshot effectiveAt') <= opening;
        if (!allowed) excludedSnapshots++;
        return allowed;
      }).sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt)
        || Date.parse(b.availableAt) - Date.parse(a.availableAt));
      const snap = admissible[0];
      requireThat(snap && source(snap.source), `${s.season}/${t.teamId}: missing admissible opening snapshot and source`);
      if (admissible[1]) requireThat(snap.effectiveAt !== admissible[1].effectiveAt
        || snap.availableAt !== admissible[1].availableAt, 'Ambiguous duplicate snapshot timestamps');
      requireThat(Array.isArray(snap.players), 'Snapshot players required');
      for (const row of snap.players) {
        requireThat(timestamp(row.availableAt, 'player availableAt') <= Date.parse(snap.availableAt),
          `Future player input ${row.playerId}: availableAt exceeds snapshot`);
        requireThat(!rosterIds.has(row.playerId), `Player ${row.playerId} appears on multiple opening rosters`);
        rosterIds.add(row.playerId);
      }
      const rotation = projectRotation(snap.players);
      const currentIds = new Set(snap.players.map((r) => r.playerId));
      const departed = p.players.reduce((sum, r) => sum + (currentIds.has(r.playerId) ? 0 : r.minutes), 0);
      teams.set(t.teamId, { ...t, rotation, rawRating: rosterRating(rotation),
        departureShare: departed / priorMinutes });
    }
    requireThat(s.snapshots.every((r) => teams.has(r.teamId)), 'Snapshot references an unknown team');
    const meanRating = [...teams.values()].reduce((sum, t) => sum + t.rawRating, 0) / teams.size;
    for (const t of teams.values()) {
      t.rosterPoints = (t.rawRating - meanRating) * t.prior.pace / 100;
      requireThat(finite(t.rosterPoints), 'Nonfinite centered roster points: input overflow');
    }
    const seen = new Set();
    const games = s.games.map((g) => {
      requireThat(typeof g.gameId === 'string' && g.gameId.length > 0 && !seen.has(g.gameId), 'Invalid or duplicate gameId');
      seen.add(g.gameId);
      requireThat(teams.has(g.homeId) && teams.has(g.awayId) && g.homeId !== g.awayId, 'Invalid game teams');
      requireThat(Number.isSafeInteger(g.homeScore) && g.homeScore >= 0 && Number.isSafeInteger(g.awayScore)
        && g.awayScore >= 0 && g.homeScore !== g.awayScore, 'Completed game scores required (no ties)');
      requireThat(typeof g.neutral === 'boolean', 'Explicit neutral flag required');
      requireThat(typeof g.date === 'string' && /^\d{4}-\d\d-\d\d$/.test(g.date)
        && Number.isFinite(Date.parse(g.date)) && new Date(g.date).toISOString().slice(0, 10) === g.date, 'Invalid schedule date');
      const prediction = timestamp(g.predictionAt, 'predictionAt');
      const result = timestamp(g.resultAt, 'resultAt');
      requireThat(prediction >= opening && result > prediction, 'Invalid game chronology: resultAt must follow predictionAt and opening');
      if (dataset.seasons[seasonIndex + 1]) {
        requireThat(result < timestamp(dataset.seasons[seasonIndex + 1].openingAt, 'next openingAt'),
          `${s.season}: results overlap the next season opening`);
      }
      return { ...g, prediction, result };
    }).sort((a, b) => a.prediction - b.prediction || a.gameId.localeCompare(b.gameId));
    return { ...s, opening, teams, games, excludedSnapshots };
  });
}

function optionsOf(dataset, options) {
  const parameters = dataset?.parameters;
  requireThat(parameters && source(parameters.source), 'Dated calibration parameters and source required');
  requireThat(timestamp(parameters.availableAt, 'calibration availableAt')
    <= timestamp(dataset.seasons?.[0]?.openingAt, 'first openingAt'),
  'Calibration parameters must be available before training begins');
  if (dataset.kind === 'historical') requireThat(Object.keys(options).every((key) => key === 'blend'),
    'Undated historical calibration overrides are prohibited; supply dated dataset.parameters');
  const opts = { blend: 0.5, k: parameters.k, homeAdv: parameters.homeAdv,
    restWeight: parameters.restWeight, spreadSd: parameters.spreadSd, ...options };
  requireThat(finite(opts.blend) && opts.blend >= 0 && opts.blend <= 1, 'blend must be in [0,1]');
  requireThat(finite(opts.k) && opts.k >= 0 && finite(opts.homeAdv)
    && finite(opts.restWeight) && opts.restWeight >= 0 && finite(opts.spreadSd) && opts.spreadSd > 0,
  'Invalid shared prediction parameters');
  return opts;
}

function probability(margin, sd) {
  const x = Math.abs(margin / (sd * Math.SQRT2)); const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return Math.max(1e-12, Math.min(1 - 1e-12, 0.5 * (1 + Math.sign(margin) * erf)));
}

function replay(seasons, dataset, opts) {
  const records = []; const coverage = [];
  const restAdjust = (n) => n == null ? 0 : ({ 0: -1.1, 1: 0, 2: 0.35 }[n] ?? 0.5);
  for (const s of seasons) {
    const initial = Object.fromEntries([...s.teams].map(([tid, t]) => [tid, t.prior.eloStart]));
    let baseline = { ...initial };
    let candidate = Object.fromEntries([...s.teams].map(([tid, t]) => [tid,
      (1 - opts.blend) * t.prior.eloStart + opts.blend * (ELO_BASE + t.rosterPoints * ELO_PER_POINT)]));
    requireThat(Object.values(candidate).every(finite), 'Nonfinite initial Elo: input overflow');
    const completed = new Map(); const lastDate = new Map();
    const results = [...s.games].sort((a, b) => a.result - b.result || a.gameId.localeCompare(b.gameId));
    let nextResult = 0;
    for (const g of s.games) {
      while (nextResult < results.length && results[nextResult].result <= g.prediction) {
        const r = results[nextResult++];
        const game = { gameId: r.gameId, date: r.date, neutral: r.neutral,
          home: { teamId: r.homeId, pts: r.homeScore, win: r.homeScore > r.awayScore },
          away: { teamId: r.awayId, pts: r.awayScore, win: r.awayScore > r.homeScore } };
        baseline = computeElo([game], { initial: baseline, k: opts.k }).final;
        candidate = computeElo([game], { initial: candidate, k: opts.k }).final;
        requireThat([...Object.values(baseline), ...Object.values(candidate)].every(finite),
          'Nonfinite Elo update: input overflow');
        for (const tid of [r.homeId, r.awayId]) completed.set(tid, (completed.get(tid) ?? 0) + 1);
      }
      const day = Date.parse(g.date) / 86400000;
      const rest = (tid) => lastDate.has(tid) ? Math.max(0, day - lastDate.get(tid) - 1) : null;
      const context = (g.neutral ? 0 : opts.homeAdv)
        + (restAdjust(rest(g.homeId)) - restAdjust(rest(g.awayId))) * opts.restWeight;
      const baseMargin = (baseline[g.homeId] - baseline[g.awayId]) / ELO_PER_POINT + context;
      const margins = {
        baseline: baseMargin,
        legacy: baseMargin + s.teams.get(g.homeId).prior.turnoverAdj - s.teams.get(g.awayId).prior.turnoverAdj,
        candidate: (candidate[g.homeId] - candidate[g.awayId]) / ELO_PER_POINT + context,
      };
      requireThat(Object.values(margins).every(finite), 'Nonfinite predicted margin: input overflow');
      const teamGp = Math.min(completed.get(g.homeId) ?? 0, completed.get(g.awayId) ?? 0);
      records.push({ season: s.season, gameId: g.gameId, date: g.date, teamGp, early: teamGp < 10,
        highTurnover: [g.homeId, g.awayId].some((tid) => s.teams.get(tid).departureShare >= dataset.highTurnoverThreshold),
        actual: g.homeScore - g.awayScore,
        ...Object.fromEntries(Object.entries(margins).map(([key, margin]) => [key, { margin, p: probability(margin, opts.spreadSd) }])) });
      lastDate.set(g.homeId, day); lastDate.set(g.awayId, day);
    }
    coverage.push({ season: s.season, games: s.games.length, excludedSnapshots: s.excludedSnapshots,
      teams: [...s.teams.values()].map((t) => ({ teamId: t.teamId, departureShare: t.departureShare,
        priorMinutes: t.rotation.priorMinutes, rosterPoints: t.rosterPoints })) });
  }
  return { records, coverage };
}

export function replayExperiment(dataset, options = {}) {
  const opts = optionsOf(dataset, options);
  return replay(prepare(dataset), dataset, opts);
}

function scores(records, model) {
  if (!records.length) return null;
  const sum = records.reduce((acc, r) => {
    const y = r.actual > 0 ? 1 : 0; const p = r[model].p;
    acc.logLoss -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
    acc.brier += (p - y) ** 2;
    acc.mae += Math.abs(r[model].margin - r.actual);
    return acc;
  }, { logLoss: 0, brier: 0, mae: 0 });
  const result = Object.fromEntries(Object.entries(sum).map(([key, value]) => [key, value / records.length]));
  requireThat(Object.values(result).every(finite), 'Nonfinite prediction metrics: input overflow');
  return result;
}

function paired(records, reference) {
  if (!records.length) return null;
  const delta = (rows) => {
    const c = scores(rows, 'candidate'); const b = scores(rows, reference);
    return Object.fromEntries(Object.keys(c).map((key) => [key, c[key] - b[key]]));
  };
  const blocks = [...new Set(records.map((r) => r.season))].map((s) => records.filter((r) => r.season === s));
  const difference = delta(records);
  let interval95 = null;
  if (blocks.length > 1) {
    let seed = 1234567;
    const draws = Object.fromEntries(Object.keys(difference).map((k) => [k, []]));
    for (let n = 0; n < 1000; n++) {
      const sampled = [];
      for (let i = 0; i < blocks.length; i++) {
        seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
        sampled.push(...blocks[Math.floor(seed / 4294967296 * blocks.length)]);
      }
      const d = delta(sampled);
      for (const key of Object.keys(draws)) draws[key].push(d[key]);
    }
    interval95 = Object.fromEntries(Object.entries(draws).map(([key, values]) => {
      values.sort((a, b) => a - b); return [key, [values[24], values[974]]];
    }));
  }
  return { reference, difference, interval95, seasons: blocks.length,
    intervalMethod: 'paired season-block bootstrap' };
}

function summary(records) {
  return { n: records.length, baseline: scores(records, 'baseline'), legacy: scores(records, 'legacy'),
    candidate: scores(records, 'candidate'), paired: paired(records, 'baseline'),
    pairedLegacy: paired(records, 'legacy') };
}

export function evaluateExperiment(dataset, options = {}) {
  const opts = optionsOf(dataset, options);
  const seasons = prepare(dataset);
  const training = dataset.trainingSeasons;
  requireThat(Array.isArray(training) && training.length > 0 && training.length < seasons.length
    && training.every((s, i) => s === seasons[i].season), 'trainingSeasons must be a nonempty chronological prefix with a holdout');
  const train = seasons.slice(0, training.length); const holdout = seasons.slice(training.length);
  requireThat(Math.max(...train.flatMap((s) => s.games.map((g) => g.result))) <= holdout[0].opening,
    'Training outcomes must be available before holdout opening');
  const grid = dataset.blendGrid;
  requireThat(Array.isArray(grid) && grid.length >= 2 && grid.length <= 21
    && new Set(grid).size === grid.length && grid.includes(0) && grid.includes(1)
    && grid.every((v) => finite(v) && v >= 0 && v <= 1), 'blendGrid must include 0 and 1 and contain at most 21 distinct weights in [0,1]');
  const trials = [...grid].sort((a, b) => a - b).map((blend) => {
    const r = replay(train, dataset, { ...opts, blend });
    return { blend, n: r.records.length, ...scores(r.records, 'candidate') };
  });
  const selected = trials.reduce((best, trial) => trial.logLoss < best.logLoss - 1e-12 ? trial : best);
  const result = replay(holdout, dataset, { ...opts, blend: selected.blend });
  const warnings = [];
  if (dataset.kind !== 'historical') warnings.push(`${dataset.kind.toUpperCase()}: cannot establish NBA model improvement`);
  if (holdout.length < 5) warnings.push(`Only ${holdout.length} holdout seasons; season-block uncertainty is weak`);
  warnings.push('Opening snapshots are frozen: midseason trades and updated injury forecasts are outside this experiment');
  return {
    kind: dataset.kind, selectedBlend: selected.blend, trainingSeasons: training,
    holdoutSeasons: holdout.map((s) => s.season), training: trials,
    parameters: { ...opts, blend: selected.blend, availableAt: dataset.parameters.availableAt,
      source: dataset.parameters.source }, highTurnoverThreshold: dataset.highTurnoverThreshold,
    warnings, coverage: result.coverage,
    holdout: { all: summary(result.records), early: summary(result.records.filter((r) => r.early)),
      highTurnover: summary(result.records.filter((r) => r.highTurnover)),
      seasons: holdout.map((s) => ({ season: s.season, ...summary(result.records.filter((r) => r.season === s.season)) })) },
    records: result.records,
  };
}
