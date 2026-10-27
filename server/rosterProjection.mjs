/** Experimental projections. Inputs are forecasts, never future actual minutes. */
const MINUTES = 240;
const EPSILON = 1e-8;

function allocate(weights, caps) {
  if (caps.reduce((s, c) => s + c, 0) < MINUTES - EPSILON) {
    throw new Error('Insufficient rotation capacity: need 240 minutes from eligible players');
  }
  const minutes = weights.map(() => 0);
  let remaining = MINUTES;
  while (remaining > EPSILON) {
    const active = caps.map((cap, i) => i).filter((i) => caps[i] - minutes[i] > EPSILON);
    const scale = active.reduce((largest, i) => Math.max(largest, weights[i]), 0);
    const totalWeight = scale > 0 ? active.reduce((s, i) => s + weights[i] / scale, 0) : 0;
    const before = remaining;
    for (const i of active) {
      const share = totalWeight > 0 ? (weights[i] / scale) / totalWeight : 1 / active.length;
      const added = Math.min(caps[i] - minutes[i], before * share);
      minutes[i] += added;
      remaining -= added;
    }
  }
  return minutes;
}

export function projectRotation(players) {
  if (!Array.isArray(players) || !players.length) throw new Error('Missing rotation players');
  const ids = new Set();
  const rows = players.map((p) => {
    if (!Number.isSafeInteger(p.playerId) || p.playerId <= 0) throw new Error('Invalid playerId');
    if (ids.has(p.playerId)) throw new Error(`Duplicate player ${p.playerId}`);
    ids.add(p.playerId);
    if (!Number.isFinite(p.projectedMinutes) || p.projectedMinutes < 0) {
      throw new Error(`Invalid projectedMinutes for player ${p.playerId}`);
    }
    if (!Number.isFinite(p.availability) || p.availability < 0 || p.availability > 1) {
      throw new Error(`Invalid availability for player ${p.playerId}`);
    }
    const fromPrior = p.impact == null;
    const impact = fromPrior ? p.impactPrior?.value : p.impact;
    if (!Number.isFinite(impact)) throw new Error(`Missing or invalid impact for player ${p.playerId}`);
    if (fromPrior && (typeof p.impactPrior.source !== 'string' || !p.impactPrior.source.trim())) {
      throw new Error(`An impact prior needs a source for player ${p.playerId}`);
    }
    return { ...p, impact, fromPrior };
  });
  const healthy = allocate(rows.map((p) => p.projectedMinutes), rows.map(() => 48));
  const expected = allocate(healthy.map((m, i) => m * rows[i].availability),
    rows.map((p) => 48 * p.availability));
  const rotation = rows.map((p, i) => ({ ...p, healthyMinutes: healthy[i], minutes: expected[i] }));
  return {
    players: rotation,
    priorMinutes: rotation.reduce((s, p) => s + (p.fromPrior ? p.minutes : 0), 0),
  };
}

export function rosterRating(rotation) {
  const rating = rotation.players.reduce((s, p) => s + p.impact * (p.minutes / 48), 0);
  if (!Number.isFinite(rating)) throw new Error('Nonfinite roster rating: input overflow');
  return rating;
}
