# Dated inputs for the roster experiment

This is an offline research format, separate from production `data/*.json`.
Run `npm run backtest:roster -- --input path/to/dataset.json`.
Without `--input`, the runner audits the local data and explains what is missing.

## Dataset (schemaVersion 1)

- `kind`: `historical`, `exploratory`, or `synthetic`. Synthetic and exploratory
  results are never presented as validated NBA improvements.
- `rosterMode`: `opening` or `full-season`. Full-season rosters are allowed only
  for exploratory datasets because they expose future acquisitions.
- `seasons`: at least two consecutive seasons, ordered chronologically.
- `trainingSeasons`: an explicit prefix of season names. All remaining seasons
  are holdout seasons. Blend selection cannot access holdout outcomes.
- `blendGrid`: a small list of distinct weights in [0,1], including 0 and 1.
- `highTurnoverThreshold`: predeclared fraction in (0,1], e.g. 0.3. A team is in
  the high-turnover group when at least this share of its prior-season minutes
  belonged to players absent from the opening roster. Do not tune to outcomes.
- `parameters`: `{availableAt, source, homeAdv, restWeight, spreadSd, k}`. These
  shared calibration settings must have been available by the first training
  opening. Do not reuse today's fitted production defaults for historical
  holdouts. Numeric settings overrides are prohibited for historical datasets.

Each season contains:

- `season`: NBA season name, e.g. `2024-25`.
- `openingAt`: the time the preseason projection is frozen.
- `complete: true`, `expectedGames`: declared complete schedule size, matching
  the number of games supplied. These declarations still need source verification.
- `source`: game-log provenance, including an archive URL or file reference.
- `teams`: the complete league (30 for historical NBA datasets). Each team has
  numeric `teamId` and `prior` containing `availableAt`, `source`, `eloStart`,
  `pace`, `turnoverAdj`, and `players: [{playerId, minutes}]`.
  `eloStart` is the existing Elo after 75% carryover. `turnoverAdj` is the
  existing legacy correction in points per game, already weighted (normally
  0.15); it must use only inputs known at opening. `players` records actual
  prior-season minutes per player for the continuity calculation.
- `snapshots`: team rows with `teamId`, `effectiveAt`, `availableAt`, `source`,
  and `players`. The latest snapshot effective and available by `openingAt`
  is selected. Later revisions are excluded and counted, never backfilled.
- `games`: `{gameId, date, predictionAt, resultAt, homeId, awayId, homeScore,
  awayScore, neutral}`. `date` is the league schedule date (YYYY-MM-DD).
  `resultAt` is when the completed score was available, after `predictionAt`.
  Only results already available at prediction time update the model.
  Each season's results must precede the following season's opening.

Every player forecast contains:

```json
{
  "playerId": 123,
  "availableAt": "2024-10-20T12:00:00Z",
  "projectedMinutes": 32,
  "availability": 1,
  "impact": 2.5
}
```

`availableAt` certifies availability of the whole row: roster membership,
minutes, injury/availability and impact information. It cannot be later than
the snapshot's availability. All timestamps require a timezone. Source fields
must identify where the forecasts came from; timestamp validation cannot prove
that a claimed forecast was genuinely produced at that time.

`availability` is a probability in [0,1], distinct from healthy projected minutes.
Zero excludes a player; partial availability caps expected minutes at
`48 * availability`. The allocator normalizes healthy role weights to 240 minutes,
then distributes expected minutes among available players with remaining capacity.
Supply eligible replacement players explicitly, even when projectedMinutes is zero.
This is a transparent heuristic to test, not a fitted minutes model.

If `impact` is null or absent, provide
`impactPrior: {"value": -1, "source": "identified prior model/version"}`.
Priors are reported by their allocated minutes. No draft coefficients are built
in. All impact estimates must share one scale: additive points per 100 possessions
relative to an average player. PIE is not a valid substitute for this scale.

## Calculation and selection

Roster rating is `sum(impact * expectedMinutes / 48)`, centered on the complete
league, then multiplied by the prior pace / 100. Candidate initial points are
`(1 - blend) * (eloStart - 1500) / 28 + blend * rosterPoints`. They are converted
back to Elo and updated using the existing Elo implementation. The roster effect
is applied once, not added permanently after each update.

The runner compares pure rolling Elo, rolling Elo plus the supplied legacy
turnover adjustment, and the candidate. Home advantage, rest, spread uncertainty
and Elo K are shared and come from the dated calibration in `parameters`.
The grid weight minimizing pooled training log loss is frozen for holdout;
ties favor the smaller roster weight. Full-season and subgroup metrics are
reported separately. Early season means either team has fewer than 10 prior games.

Uncertainty uses deterministic paired bootstrap resampling of complete seasons,
so all games within a season stay together. Fewer than five holdout seasons
triggers an explicit small-sample warning; intervals with one season are omitted.
Intervals do not account for model selection or unknown input errors.

The fixture in `tests/fixtures/roster-experiment/synthetic.json` is a runnable
format example only. Its small invented league cannot establish NBA accuracy.
