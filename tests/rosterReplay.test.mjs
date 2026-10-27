import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { replayExperiment, evaluateExperiment } from '../server/rosterReplay.mjs';

const fixture = () => JSON.parse(fs.readFileSync(new URL('./fixtures/roster-experiment/synthetic.json', import.meta.url)));

test('zero roster blend reproduces pure Elo; legacy adjustment remains a separate baseline', () => {
  const { records } = replayExperiment(fixture(), { blend: 0 });
  assert.equal(records.length, 36);
  for (const r of records) assert.deepEqual(r.candidate, r.baseline);
  assert.ok(Math.abs(records[0].legacy.margin - records[0].baseline.margin - 0.4) < 1e-8);
});

test('centers roster strength, converts pace, and applies roster information only at initialization', () => {
  const d = fixture();
  d.seasons[0].teams.forEach((t) => { t.prior.pace = 110; });
  const { records } = replayExperiment(d, { blend: 1, homeAdv: 0, restWeight: 0, k: 0 });
  assert.ok(Math.abs(records[0].candidate.margin - 5.5) < 1e-8);
  assert.ok(Math.abs(records[1].candidate.margin + 5.5) < 1e-8);
});

test('future roster revisions are excluded and individually future player inputs rejected', () => {
  const d = fixture();
  const revision = structuredClone(d.seasons[0].snapshots[0]);
  revision.availableAt = '2023-11-01T12:00:00Z';
  revision.players.forEach((p) => { p.impact = 99; });
  d.seasons[0].snapshots.push(revision);
  assert.deepEqual(replayExperiment(d).records, replayExperiment(fixture()).records);
  assert.equal(replayExperiment(d).coverage[0].excludedSnapshots, 1);
  d.seasons[0].snapshots[0].players[0].availableAt = '2023-12-01T00:00:00Z';
  assert.throws(() => replayExperiment(d), /future|availableAt/i);
});

test('predicts before updating and waits until results are available', () => {
  const d = fixture();
  const before = replayExperiment(d).records;
  d.seasons[0].games[0].homeScore = 80;
  const after = replayExperiment(d).records;
  assert.deepEqual(before[0].baseline, after[0].baseline);
  assert.notDeepEqual(before[1].baseline, after[1].baseline);
  d.seasons[0].games[0].resultAt = '2023-10-23T22:00:00Z';
  const changed = structuredClone(d); changed.seasons[0].games[0].homeScore = 140;
  const a = replayExperiment(d).records; const b = replayExperiment(changed).records;
  assert.deepEqual(a[1].baseline, b[1].baseline);
  assert.notDeepEqual(a[3].baseline, b[3].baseline);
});

test('holdout outcomes cannot influence blend selection or prior predictions', () => {
  const d = fixture(); const first = evaluateExperiment(d);
  for (const s of d.seasons.slice(1)) for (const g of s.games) [g.homeScore, g.awayScore] = [g.awayScore, g.homeScore];
  const second = evaluateExperiment(d);
  assert.equal(first.selectedBlend, second.selectedBlend);
  assert.deepEqual(first.training, second.training);
  assert.deepEqual(first.records[0].candidate, second.records[0].candidate);
  assert.notDeepEqual(first.holdout.all.candidate, second.holdout.all.candidate);
});

test('early-season boundary, departure share and explicit impact priors are reported', () => {
  const d = fixture(); const p = d.seasons[0].snapshots[0].players[0];
  delete p.impact; p.impactPrior = { value: 1, source: 'synthetic prior' };
  const r = replayExperiment(d);
  assert.equal(r.records.filter((g) => g.early).length, 30);
  assert.equal(r.records[10].early, false);
  assert.equal(r.records[0].highTurnover, true);
  assert.ok(Math.abs(r.coverage[0].teams[0].departureShare - 1 / 3) < 1e-8);
  assert.equal(r.coverage[0].teams[1].departureShare, 0);
  assert.equal(r.coverage[0].teams[0].priorMinutes, 40);
  const report = evaluateExperiment(d);
  assert.equal(report.holdout.all.n, 24);
  assert.equal(report.holdout.early.n, 20);
  assert.equal(report.holdout.highTurnover.n, 24);
  assert.equal(report.holdout.seasons.length, 2);
  assert.equal(report.holdout.all.paired.intervalMethod, 'paired season-block bootstrap');
});

test('uses either team’s prior game count for the early-season subgroup', () => {
  const d = fixture();
  // Team 3 joins this matchup late; teams 1 and 2 have already played 10 games.
  const team = structuredClone(d.seasons[0].teams[1]); team.teamId = 3;
  const snap = structuredClone(d.seasons[0].snapshots[1]); snap.teamId = 3;
  team.prior.players.forEach((p) => { p.playerId += 100; });
  snap.players.forEach((p) => { p.playerId += 100; });
  d.seasons[0].teams.push(team); d.seasons[0].snapshots.push(snap);
  d.seasons[0].games[10].awayId = 3;
  assert.equal(replayExperiment(d).records[10].early, true);
});

test('an unavailable incoming star contributes no expected impact', () => {
  const d = fixture();
  const rows = d.seasons[0].snapshots[0].players;
  rows.forEach((p) => { p.impact = 0; });
  rows[0].impact = 10; rows[0].availability = 0;
  assert.equal(replayExperiment(d, { blend: 1, homeAdv: 0 }).records[0].candidate.margin, 0);
  rows[0].availability = 1;
  assert.ok(replayExperiment(d, { blend: 1, homeAdv: 0 }).records[0].candidate.margin > 8);
});

test('rejects invalid chronology, duplicate games, incomplete schedules and inadmissible rosters', () => {
  for (const mutate of [
    (d) => { d.seasons[0].complete = false; },
    (d) => { d.seasons[0].expectedGames = 1230; },
    (d) => { d.seasons[0].games[1].gameId = d.seasons[0].games[0].gameId; },
    (d) => { d.seasons[0].games[0].resultAt = d.seasons[0].openingAt; },
    (d) => { d.seasons[0].snapshots[0].availableAt = '2023-12-01T00:00:00Z'; },
    (d) => { d.trainingSeasons = ['2025-26']; },
    (d) => { d.rosterMode = 'full-season'; },
    (d) => { d.seasons[1].teams[0].prior.eloStart = Infinity; },
  ]) {
    const d = fixture(); mutate(d); assert.throws(() => evaluateExperiment(d));
  }
});

test('requires sourced calibration known before training and rejects undated historical overrides', () => {
  const d = fixture();
  d.parameters = { availableAt: '2023-10-19T00:00:00Z', source: 'synthetic fixed calibration',
    k: 20, homeAdv: 1.6, restWeight: 1.8, spreadSd: 12 };
  const before = replayExperiment(d);
  d.parameters.homeAdv = 0;
  assert.ok(Math.abs(before.records[0].baseline.margin - replayExperiment(d).records[0].baseline.margin - 1.6) < 1e-8);
  d.parameters.availableAt = '2025-01-01T00:00:00Z';
  assert.throws(() => evaluateExperiment(d), /calibration|parameter/i);
  d.parameters.availableAt = '2023-10-19T00:00:00Z';
  d.kind = 'historical';
  assert.throws(() => replayExperiment(d, { homeAdv: 7 }), /override/i);
  delete d.parameters;
  assert.throws(() => replayExperiment(d), /calibration|parameter/i);
});

test('rejects nonfinite derived ratings rather than publishing NaN prediction metrics', () => {
  const d = fixture();
  d.seasons[0].snapshots[0].players.forEach((p) => { p.impact = 1e308; });
  assert.throws(() => evaluateExperiment(d), /finite|overflow/i);
});

test('rejects season results that overlap the next season opening', () => {
  const d = fixture(); const g = d.seasons[1].games.at(-1);
  g.date = '2025-10-22'; g.predictionAt = '2025-10-22T18:00:00Z'; g.resultAt = '2025-10-22T21:00:00Z';
  assert.throws(() => evaluateExperiment(d), /next season|overlap/i);
});

test('evaluates the historical schema with 30 teams and 1230 games per season', () => {
  // Invented data exercises full NBA dimensions; it is not accuracy evidence.
  const d = fixture(); d.kind = 'historical';
  for (const s of d.seasons) {
    const stamp = s.openingAt;
    s.teams = []; s.snapshots = []; s.games = [];
    for (let tid = 1; tid <= 30; tid++) {
      const rows = Array.from({ length: 6 }, (_, i) => ({ playerId: tid * 100 + i,
        availableAt: stamp, projectedMinutes: 40, availability: 1, impact: tid === 1 ? 1 : 0 }));
      s.teams.push({ teamId: tid, prior: { availableAt: stamp, source: 'synthetic test prior',
        eloStart: 1500, pace: 100, turnoverAdj: 0,
        players: rows.map((p) => ({ playerId: p.playerId, minutes: 3280 })) } });
      s.snapshots.push({ teamId: tid, effectiveAt: stamp, availableAt: stamp, source: 'synthetic test forecast', players: rows });
    }
    let circle = Array.from({ length: 30 }, (_, i) => i + 1);
    for (let round = 0; round < 82; round++) {
      const date = new Date(Date.parse(stamp) + (round + 1) * 86400000).toISOString().slice(0, 10);
      for (let match = 0; match < 15; match++) s.games.push({
        gameId: `${s.season}-${round}-${match}`, date,
        predictionAt: `${date}T18:00:00Z`, resultAt: `${date}T21:00:00Z`,
        homeId: circle[match], awayId: circle[29 - match], homeScore: 105, awayScore: 100, neutral: false,
      });
      circle = [circle[0], circle.at(-1), ...circle.slice(1, -1)];
    }
    s.expectedGames = 1230;
  }
  const report = evaluateExperiment(d);
  assert.equal(report.holdout.all.n, 2460);
  assert.equal(report.holdout.early.n, 300);
  assert.equal(report.holdout.highTurnover.n, 0);
  assert.equal(report.holdout.highTurnover.candidate, null);
  assert.ok(Number.isFinite(report.holdout.all.candidate.logLoss));
  assert.ok(report.coverage.every((s) => s.teams.length === 30));
});
