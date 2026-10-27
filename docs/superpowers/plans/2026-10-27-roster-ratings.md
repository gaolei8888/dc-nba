# Roster-aware Ratings Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan
> task-by-task after design approval. Native execution is recommended because the
> tasks share the projection and replay interfaces.

**Goal:** Compare roster-initialized rolling Elo with existing baselines without
changing production rankings before held-out evidence supports it.

**Architecture:** A pure roster projection module consumes dated inputs. A separate
offline runner replays games chronologically and reports paired model results.
Production prediction routes remain unchanged during the experiment.

**Tech Stack:** Existing Node.js ES modules; `node:test`; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-roster-ratings-design.md`

## Global Constraints

- Allocate exactly 240 regulation minutes, with a 48-minute player maximum.
- Enforce `availableAt <= predictionAt` for every prediction input.
- Learn calibration and blend weights using earlier seasons only.
- Missing historical inputs must produce an actionable report; no silent fetches.
- Synthetic fixtures validate code, not NBA accuracy.
- No automatic promotion of candidate ratings to production.

## Review Focus

- Incomplete or infeasible rotations fail explicitly rather than leave minutes unallocated.
- Injured players receive zero minutes and their minutes move to eligible teammates.
- Traded players and future input revisions cannot appear before their availability time.
- Missing impact is explicitly marked and never silently treated as a measured zero.
- Early-season subgroup includes games where either team has fewer than 10 prior games.

### Task 1: Dated projection inputs and roster estimate

**Files:** Create `server/rosterProjection.mjs`,
`tests/rosterProjection.test.mjs`, and `docs/roster-experiment-inputs.md`.

**Interfaces:** Define and document dated snapshots containing season, teamId,
effectiveAt, availableAt, predictionAt and player rows. Export
`projectRotation(players)` returning allocated minutes and diagnostic coverage;
`rosterRating(rotation)` returning points per 100 possessions.

- [x] Write failing tests: minutes total 240; each player stays within 0–48;
  absent players get zero; feasible teammate capacity receives the remainder;
  impossible capacity fails; an unknown impact requires an explicit prior.
- [x] Test the additive scale: five 48-minute average players yield zero;
  one +6 player over 24 minutes with average teammates yields +3.
- [x] Implement capped allocation using supplied projected-minute preferences,
  availability and explicit eligible replacement rows. Reject nonfinite inputs.
- [x] Verify `node --test tests/rosterProjection.test.mjs` passes.

### Task 2: Chronological model comparison

**Files:** Create `server/rosterReplay.mjs`, `tests/rosterReplay.test.mjs`,
and fixture data under `tests/fixtures/roster-experiment/`.

**Interfaces:** `replayExperiment(dataset, options)` consumes the documented
snapshots, complete game logs and historical starting Elo; returns prediction
records for baseline and candidate using identical game IDs and context settings.

- [x] Write failing tests for future snapshot exclusion, predict-before-update,
  endpoint blend equivalence, explicit pace conversion, and training/holdout
  separation. Test the early-season subgroup boundary and absent impact coverage.
- [x] Implement initialization from centered roster points and historical Elo;
  update through existing Elo calculations without a permanent roster offset.
- [x] Add fixture comparisons for a departure, an injured incoming star and a
  stable roster. Verify moving future results cannot alter earlier predictions.
- [x] Verify `node --test tests/rosterReplay.test.mjs` passes.

### Task 3: Runner, data audit and result report

**Files:** Create `scripts/roster-backtest.mjs`,
`tests/rosterBacktest.test.mjs`; modify `package.json` and `README.md`.

**Interfaces:** `npm run backtest:roster -- --input <dataset.json>` validates the
dataset, performs chronological blend selection, and prints sample coverage,
full-season/early/high-turnover scores, paired differences and per-season results.
Document training boundaries, the turnover definition and uncertainty procedure.

- [x] Write failing CLI tests for missing inputs, incomplete seasons, disallowed
  future inputs and a complete synthetic run. Distinguish exploratory data from
  admissible held-out inputs in output.
- [x] Implement offline reporting and a data audit with required files/fields.
  Never infer rosters from later-season stint participation.
- [x] Run the complete test suite, `npm run build`, and the fixture experiment.
- [x] Run the real-data audit. If inputs remain absent, report precisely which
  are missing and leave empirical model superiority unclaimed.
- [x] Save a verdict with reproducible commands and limitations. Review the diff
  before proposing any production integration.
