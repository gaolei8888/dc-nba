import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRotation, rosterRating } from '../server/rosterProjection.mjs';

const players = () => Array.from({ length: 8 }, (_, i) => ({
  playerId: i + 1, projectedMinutes: 30, availability: 1, impact: 0,
}));
const sum = (r) => r.players.reduce((s, p) => s + p.minutes, 0);

test('redistributes an absent player’s minutes without exceeding regulation capacity', () => {
  const roster = players(); roster[0].availability = 0;
  const r = projectRotation(roster);
  assert.ok(Math.abs(sum(r) - 240) < 1e-8);
  assert.equal(r.players[0].minutes, 0);
  assert.ok(r.players.slice(1).every((p) => p.minutes > 30 && p.minutes <= 48));
  assert.equal(roster[1].projectedMinutes, 30);
});

test('caps heavy minutes and fills from explicitly supplied eligible replacements', () => {
  const roster = players(); roster[0].projectedMinutes = 90;
  const r = projectRotation(roster);
  assert.equal(r.players[0].minutes, 48);
  assert.ok(Math.abs(sum(r) - 240) < 1e-8);
  const zeros = players().map((p) => ({ ...p, projectedMinutes: 0 }));
  assert.ok(Math.abs(sum(projectRotation(zeros)) - 240) < 1e-8);
});

test('partial availability limits expected minutes and preserves healthy rotation', () => {
  const roster = players(); roster[0].availability = 0.25;
  const r = projectRotation(roster);
  assert.equal(r.players[0].healthyMinutes, 30);
  assert.ok(r.players[0].minutes <= 12);
  assert.ok(Math.abs(sum(r) - 240) < 1e-8);
});

test('rejects infeasible rotations instead of leaving minutes unallocated', () => {
  assert.throws(() => projectRotation(players().slice(0, 4)), /capacity/i);
  const roster = players(); roster.forEach((p) => { p.availability = 0.5; });
  assert.throws(() => projectRotation(roster), /capacity/i);
});

test('uses the additive 48-minute impact scale', () => {
  const roster = players().slice(0, 5).map((p) => ({ ...p, projectedMinutes: 48 }));
  assert.equal(rosterRating(projectRotation(roster)), 0);
  const six = [...roster.slice(0, 4),
    { playerId: 5, projectedMinutes: 24, availability: 1, impact: 6 },
    { playerId: 6, projectedMinutes: 24, availability: 1, impact: 0 }];
  assert.equal(rosterRating(projectRotation(six)), 3);
});

test('requires explicit priors for unknown impact and reports prior coverage', () => {
  const roster = players(); delete roster[0].impact;
  assert.throws(() => projectRotation(roster), /impact/i);
  roster[0].impactPrior = { value: -1, source: 'synthetic rookie prior' };
  const r = projectRotation(roster);
  assert.equal(r.priorMinutes, 30);
  assert.equal(rosterRating(r), -0.625);
  assert.throws(() => projectRotation([{ ...roster[0], impactPrior: { value: 0 } }]), /source/i);
});

test('rejects duplicate players and malformed numeric projections', () => {
  assert.throws(() => projectRotation([...players(), players()[0]]), /duplicate/i);
  for (const patch of [{ projectedMinutes: NaN }, { projectedMinutes: -1 },
    { availability: 2 }, { availability: '1' }, { impact: Infinity }]) {
    assert.throws(() => projectRotation(players().map((p, i) => i ? p : { ...p, ...patch })));
  }
});

test('handles large finite minute weights without hanging or losing total minutes', () => {
  const roster = players().map((p) => ({ ...p, projectedMinutes: 1e308 }));
  const r = projectRotation(roster);
  assert.ok(Math.abs(sum(r) - 240) < 1e-8);
  assert.ok(r.players.every((p) => p.minutes === 30));
});
