# Roster-aware ratings: implementation and data verdict

Date: 2026-10-27

## Decision

Keep production rankings unchanged. The offline experiment is implemented, but
this checkout cannot establish whether it improves real NBA predictions: dated
historical opening rosters, projected minutes/availability, impact estimates and
complete game logs are missing. The five available stint datasets cannot supply
those preseason forecasts without introducing future information.

## What is implemented

- A capped 240-minute rotation with availability and explicit impact priors.
- A league-centered additive roster rating, converted to points per game.
- One-time blending into initial Elo, followed by existing rolling Elo updates.
- Pure Elo and legacy roster-adjustment comparators with shared game context.
- Chronological training/holdout separation and predict-before-update execution.
- Full-season, first-10-game and high-turnover matchup metrics, paired differences,
  per-season breakdowns, input coverage and season-block uncertainty intervals.
- Offline validation that rejects missing, incomplete or inadmissible inputs.

Independent code review found historical calibration leakage from importing
today's production home/rest defaults. The experiment now requires explicitly
dated calibration known before the first training season and prohibits undated
historical overrides. Regression tests also cover derived numeric overflow and
games incorrectly overlapping the next season. All three findings were fixed;
no review findings were deferred.

Inputs are documented in [roster-experiment-inputs.md](roster-experiment-inputs.md).
The forecasts are supplied inputs; this release does not claim to have trained a
minutes predictor or a rookie-impact model.

## Reproduction

```sh
npm test
npm run build
npm run backtest:roster -- --input tests/fixtures/roster-experiment/synthetic.json
npm run backtest:roster -- --audit
```

The audit exits 2 when a real dataset is missing. This is expected and is not a
model comparison failure. Use `--json` for structured results (with `npm --silent`
when redirecting npm output to a JSON file).

## Synthetic smoke result — not NBA evidence

An invented two-team league uses 12 training games in 2023-24 and 24 holdout games
over 2024-25 and 2025-26. The selected roster weight is 1 for this fixture.

| Holdout model | Log loss | Brier | Margin MAE |
| --- | --- | --- | --- |
| Rolling Elo | 0.40426 | 0.11253 | 4.62499 |
| Legacy adjustment | 0.38654 | 0.10478 | 4.22499 |
| Roster initialization | 0.33437 | 0.08252 | 3.02593 |

The repeated invented seasons deliberately favor the roster estimate. They test
calculation and reporting; their selected weight and narrow bootstrap intervals
have no empirical meaning for NBA basketball. Do not use them as default weights.

## Required next evidence

Prepare sourced, dated opening snapshots for all teams in several historical
seasons, with player forecasts and prior-season minutes. Supply complete official
game logs, their prediction/result availability times, and preseason Elo/context
inputs. Freeze training choices before examining the final holdout.
Home/rest/spread/Elo-K calibration also needs a source and availability timestamp
before training begins; today's fitted defaults cannot be reused retrospectively.

Compare early-season log loss/Brier and full-season errors on identical games,
with particular attention to teams losing a large fraction of prior minutes.
Treat sparse season-level intervals cautiously. Only consider production adoption
after credible held-out improvement without material full-season regression.

Opening forecasts remain frozen in this experiment. Midseason trades and daily
injury updates need their own dated replay before next-game roster ratings ship.
