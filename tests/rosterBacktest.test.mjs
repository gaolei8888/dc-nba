import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const runner = new URL('../scripts/roster-backtest.mjs', import.meta.url);
const input = new URL('./fixtures/roster-experiment/synthetic.json', import.meta.url);
const run = (...args) => spawnSync(process.execPath, [runner.pathname, ...args], { encoding: 'utf8' });

test('runs a complete synthetic comparison and clearly labels its limits', () => {
  const result = run('--input', input.pathname, '--json');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.kind, 'synthetic');
  assert.equal(report.holdout.all.n, 24);
  assert.deepEqual(report.trainingSeasons, ['2023-24']);
  assert.ok(report.warnings.some((s) => /cannot establish NBA/i.test(s)));
  assert.ok(report.holdout.all.candidate.logLoss < report.holdout.all.baseline.logLoss);
  const readable = run('--input', input.pathname);
  assert.equal(readable.status, 0);
  assert.match(readable.stdout, /SYNTHETIC/);
  assert.match(readable.stdout, /Early season/);
  assert.match(readable.stdout, /Legacy/);
  assert.match(readable.stdout, /prior minutes/i);
});

test('audits missing real inputs without fetching or inventing a result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-audit-'));
  try {
    const result = run('--audit', '--data-dir', dir, '--json');
    assert.equal(result.status, 2);
    const audit = JSON.parse(result.stdout);
    assert.equal(audit.ready, false);
    assert.ok(audit.missing.some((s) => /dated opening roster/i.test(s)));
    assert.ok(audit.missing.some((s) => /game logs/i.test(s)));
    assert.equal(fs.readdirSync(dir).length, 0);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('reports missing files and invalid command arguments with a nonzero status', () => {
  assert.equal(run('--input', '/nonexistent/roster.json').status, 2);
  assert.equal(run('--input').status, 2);
  assert.equal(run('--bogus').status, 2);
  assert.equal(run('--input', input.pathname, '--audit').status, 2);
});

test('rejects incomplete and future-dated data and labels full-season exploratory rosters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-input-'));
  const file = path.join(dir, 'input.json');
  try {
    const d = JSON.parse(fs.readFileSync(input));
    d.seasons[0].complete = false;
    fs.writeFileSync(file, JSON.stringify(d));
    assert.equal(run('--input', file).status, 2);
    d.seasons[0].complete = true;
    d.seasons[0].snapshots[0].players[0].availableAt = '2024-01-01T00:00:00Z';
    fs.writeFileSync(file, JSON.stringify(d));
    const future = run('--input', file);
    assert.equal(future.status, 2);
    assert.match(future.stderr, /Future player/);
    d.seasons[0].snapshots[0].players[0].availableAt = d.seasons[0].openingAt;
    d.kind = 'exploratory'; d.rosterMode = 'full-season';
    fs.writeFileSync(file, JSON.stringify(d));
    const exploratory = run('--input', file, '--json');
    assert.equal(exploratory.status, 0, exploratory.stderr);
    assert.match(JSON.parse(exploratory.stdout).warnings.join(' '), /EXPLORATORY/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
