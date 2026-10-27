# Roster-aware NBA ratings experiment

## Intent

Evaluate whether current rosters and projected playing time improve the app's
predictions after offseason changes. The user selected the research recommendation
to test a roster-and-minutes model alongside rolling Elo. This document makes that
recommendation concrete; its implementation choices remain proposed.

## Approaches considered

1. Increase the existing turnover weight. Cheap, but existing backtests do not
   establish a gain, and reused prior-season total minutes confuse availability
   with player quality. Do not pursue this approach.
2. Add an experimental roster-based starting estimate blended with historical
   team strength, then update from results. Recommended: directly tests the
   offseason concern and preserves a strong baseline.
3. Replace Elo with a full player and possession forecasting system. Potentially
   useful, but requires considerably more data and calibration. Defer.

## Proposed first deliverable

A reproducible experiment, not an immediate change to production rankings.
Use existing Node.js modules and the built-in Node test runner; no new dependencies.

### Roster estimate

- Consume dated roster snapshots with player IDs, projected minutes, projected
  impact in points per 100 possessions, and the time each input became available.
- Project a healthy rotation separately from expected availability. An absence
  redistributes minutes to eligible teammates; it cannot leave an empty rotation.
- Allocate exactly 240 regulation minutes, with a 48-minute player maximum.
  Validate impossible rotations instead of silently manufacturing players.
- Keep player impact separate from playing time. The rating is
  `sum(impact * minutes / 48)`, centered across the league on the same date.
- Missing player projections require an explicitly recorded prior. Rookies may
  use draft/age priors only if their coefficients were trained on earlier data.
  Do not invent draft coefficients or call a missing value measured impact.
- Initial minutes may be supplied by reviewed depth-chart snapshots. Automatic
  role/minutes forecasting is a later improvement, evaluated separately.

### Historical blend and updates

- Compare pure rolling Elo, the existing IMP adjustment, and roster-initialized
  rolling Elo on identical games and shared home/rest parameters.
- Convert the roster estimate to the existing per-game scale using a pace
  estimate available at prediction time before blending with Elo points.
- Choose the blend on earlier training seasons only. Evaluate a small fixed
  grid including both endpoints; retain a final chronological holdout.
- Apply the roster blend once at initialization, so a permanent offseason
  adjustment is not added repeatedly after results have taught Elo about it.
- Treat continuity-dependent blending and faster updates for uncertain rosters
  as separate candidates. Do not promote arbitrary continuity or learning-rate
  formulas into defaults.
- A season-opening snapshot supports offseason evaluation only. Midseason
  transactions and next-game injury rankings require additional dated snapshots.

## Evaluation and acceptance

Predict before updating from each result. Enforce `availableAt <= predictionAt`
for every roster, minutes, impact and injury input. A full-season roster or actual
future minutes cannot substitute for a historical forecast.

Report game counts, log loss, Brier score, margin MAE and paired differences for
the full season, games where either team has played fewer than 10 games, and a
predeclared high-turnover group. Define turnover from the share of prior-season
minutes belonging to departing players, using the opening snapshot; report the
threshold and sample size. Use season-level results and block uncertainty estimates
rather than treating games as independent evidence of improvement.

Promotion requires credible held-out improvement in early-season probability
quality without material full-season regression. Otherwise retain Elo and publish
the negative or inconclusive result. Never tune to make Spurs or Hawks move.

## Available data and limitations

This checkout contains five compressed stint datasets (2021-22 through 2025-26),
but no current `teams.json`, `players.json`, or `meta.json`, and no cached historical
game logs, player-impact inputs or dated roster snapshots. Stints alone do not
establish opening rosters, official final scores, draft priors or expected minutes.

The existing historical roster endpoint includes later acquisitions. Those results
must be labelled exploratory, not used as a clean offseason holdout. The new runner
must fail with an actionable missing-data report rather than fetch silently or
claim a completed comparison. Synthetic fixtures validate code, not NBA accuracy.

## Later production integration

After evaluation, show season strength and next-game availability separately, with
the data timestamp and rating components. Historical simulation must preserve the
same dated-input rules. This stage requires reviewing the experiment's results.

## Sources

- https://dunksandthrees.com/about/epm — expected impact, projected minutes,
  separate season and next-game ratings, chronological evaluation.
- https://www.darko.app/about — player-specific updating, uncertainty after team
  changes, role changes, and explicit rookie priors.
