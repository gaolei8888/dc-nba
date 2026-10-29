import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../App.jsx';
import { useI18n } from '../i18n/react.jsx';
import { api } from '../lib/api.js';
import {
  DataTable, TeamCell, StatTile, Loading, ErrorBox, Segmented,
} from '../components/common.jsx';
import { num, pct, signed, signClass } from '../lib/format.js';
import { MoneylineTab } from './LabMoneyline.jsx';

const tabs = (t) => ['build', 'errors', 'measure', 'whatif', 'market', 'beat']
  .map((value) => ({ value, label: t(`lab.tab.${value}`) }));

/** 让分分歧档位的显示顺序（与服务端 EDGE_BUCKETS 一致；点表头排序按这个顺序） */
const EDGE_ORDER = ['e0to1', 'e1to2', 'e2to3', 'e3to5', 'e5plus'];

/** 可调的模型参数。范围是根据回测里有意义的区间定的；标签与提示见 lab.param.<key>.label / hint */
const KNOBS = [
  { key: 'wElo', min: 0, max: 1, step: 0.05 },
  { key: 'wNet', min: 0, max: 1, step: 0.05 },
  { key: 'inSeasonElo', min: 0, max: 1, step: 1 },
  { key: 'homeAdv', min: 0, max: 4, step: 0.1 },
  { key: 'restWeight', min: 0, max: 3, step: 0.1 },
  { key: 'k', min: 8, max: 40, step: 1 },
  { key: 'carryKeep', min: 0.4, max: 1, step: 0.05 },
  { key: 'spreadSd', min: 8, max: 16, step: 0.5 },
];

export default function Lab() {
  const { teams, teamById, setAccent } = useApp();
  const { t } = useI18n();
  const [tab, setTab] = useState('build');
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => { setAccent(null); }, [setAccent]);
  useEffect(() => { api.labMeta().then(setMeta).catch(setError); }, []);

  if (error) return <ErrorBox error={error} />;
  if (!meta) return <Loading />;

  if (!meta.available) {
    return (
      <>
        <div className="page-head"><h1>{t('nav.lab')}</h1></div>
        <div className="card">
          <p className="note">
            {t('lab.noData.p1')}<code>npm run backtest</code>{t('lab.noData.p2')}<code>npm run ingest</code>{t('lab.noData.p3')}<code>data/backtest.json</code>{t('lab.noData.p4')}
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>{t('nav.lab')}</h1>
        <p>{t('lab.intro', { seasons: meta.seasons.join(t('lab.listSep')), count: meta.games })}</p>
      </div>

      <div className="toolbar">
        <Segmented value={tab} onChange={setTab} options={tabs(t)} />
      </div>

      {tab === 'build' && <BuildTab meta={meta} />}
      {tab === 'errors' && <ErrorsTab meta={meta} />}
      {tab === 'measure' && <MeasureTab meta={meta} />}
      {tab === 'whatif' && <WhatIfTab meta={meta} teams={teams} teamById={teamById} />}
      {tab === 'market' && <MarketTab meta={meta} />}
      {tab === 'beat' && <MoneylineTab meta={meta} />}
    </>
  );
}

// ---------------------------------------------------------------- 造模型

function BuildTab({ meta }) {
  const { t } = useI18n();
  const [params, setParams] = useState(() => ({ ...meta.defaults }));
  const [result, setResult] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [board, setBoard] = useState([]);

  // 默认参数的成绩作为基准线
  useEffect(() => {
    api.labBacktest({ params: meta.defaults })
      .then((r) => { setBaseline(r); setResult(r); })
      .catch(setErr);
  }, [meta]);

  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.labBacktest({ params });
      setResult(r);
      setBoard((b) => {
        const entry = {
          id: JSON.stringify(params),
          params: { ...params },
          ...r.summary,
          at: Date.now(),
        };
        // 同一组参数只保留一条
        const rest = b.filter((x) => x.id !== entry.id);
        return [...rest, entry].sort((x, y) => y.accuracy - x.accuracy).slice(0, 12);
      });
    } catch (e) { setErr(e); }
    setBusy(false);
  };

  const changed = JSON.stringify(params) !== JSON.stringify(meta.defaults);

  return (
    <>
      <ErrorBox error={err} />

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <StatTile
          label={t('lab.build.yourAcc')}
          value={result ? pct(result.summary.accuracy, 2) : '—'}
          hint={baseline ? t('lab.build.defaultModel', { v: pct(baseline.summary.accuracy, 2) }) : ''}
        />
        <StatTile
          label={t('lab.build.brierLabel')}
          value={result ? result.summary.brier.toFixed(4) : '—'}
          hint={baseline ? t('lab.build.defaultModel', { v: baseline.summary.brier.toFixed(4) }) : ''}
        />
        <StatTile
          label={t('lab.build.maeLabel')}
          value={result ? t('lab.pts', { v: result.summary.marginMae.toFixed(2) }) : '—'}
        />
        <StatTile
          label={t('lab.marginBias')}
          value={result ? signed(result.summary.marginBias, 2) : '—'}
          hint={t('lab.build.biasHint')}
        />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>
            {t('lab.build.params')}
            <span className="sub">{t('lab.build.paramsSub', { count: meta.games })}</span>
          </h2>
          <div className="grid cols-2">
            {KNOBS.map((k) => (
              <div key={k.key} className="field">
                <label title={t(`lab.param.${k.key}.hint`)}>
                  {t(`lab.param.${k.key}.label`)} · <b className="mono">{num(params[k.key], 2)}</b>
                </label>
                <input
                  type="range"
                  min={k.min} max={k.max} step={k.step}
                  value={params[k.key]}
                  onChange={(e) => setParams((p) => ({ ...p, [k.key]: Number(e.target.value) }))}
                />
                <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{t(`lab.param.${k.key}.hint`)}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn primary" disabled={busy} onClick={run}>
              {busy ? t('lab.replaying') : t('lab.build.run')}
            </button>
            <button className="btn" disabled={!changed} onClick={() => setParams({ ...meta.defaults })}>
              {t('lab.build.reset')}
            </button>
            <span className="note">{t('lab.build.replayNote', { count: meta.games })}</span>
          </div>
        </div>

        <div className="card">
          <h2>{t('lab.build.tried')} <span className="sub">{t('lab.build.triedSub')}</span></h2>
          {board.length === 0 ? (
            <div className="empty">{t('lab.build.triedEmpty')}</div>
          ) : (
            <DataTable
              rows={board}
              rowKey={(r) => r.id}
              initialSort={{ key: 'accuracy', dir: 'desc' }}
              onRowClick={(r) => setParams({ ...r.params })}
              columns={[
                {
                  key: 'accuracy', label: t('lab.col.accuracy'), width: 78,
                  render: (r) => <b className={baseline && r.accuracy > baseline.summary.accuracy ? 'pos' : ''}>{pct(r.accuracy, 2)}</b>,
                },
                { key: 'brier', label: 'Brier', width: 74, render: (r) => r.brier.toFixed(4) },
                { key: 'marginMae', label: t('lab.col.marginErr'), width: 78, render: (r) => r.marginMae.toFixed(2) },
                {
                  key: 'marginBias', label: t('lab.col.bias'), width: 66,
                  render: (r) => <span className={Math.abs(r.marginBias) < 0.15 ? 'pos' : ''}>{signed(r.marginBias, 2)}</span>,
                },
                {
                  key: 'desc', label: t('lab.build.colParams'), align: 'left', width: 240,
                  value: () => 0,
                  render: (r) => (
                    <span className="dim" style={{ fontSize: 11 }}>
                      {KNOBS.filter((k) => r.params[k.key] !== meta.defaults[k.key])
                        .map((k) => `${t(`lab.param.${k.key}.label`)} ${num(r.params[k.key], 2)}`)
                        .join(' · ') || t('lab.build.defaultParams')}
                    </span>
                  ),
                },
              ]}
            />
          )}
          <p className="note" style={{ marginTop: 10 }}>
            {t('lab.build.clickRow')}<br />
            <b>{t('lab.build.refLabel')}</b>{t('lab.build.refBody')}
          </p>
        </div>
      </div>

      {result && (
        <div className="card">
          <h2>{t('lab.calib.title')} <span className="sub">{t('lab.calib.sub')}</span></h2>
          <DataTable
            rows={result.calibration}
            rowKey={(r) => r.lo}
            initialSort={{ key: 'lo', dir: 'asc' }}
            columns={[
              { key: 'lo', label: t('lab.calib.range'), width: 90, render: (r) => `${r.lo}–${r.hi}%` },
              { key: 'n', label: t('lab.col.games'), width: 70 },
              { key: 'predicted', label: t('lab.calib.says'), width: 80, render: (r) => pct(r.predicted, 1) },
              { key: 'actual', label: t('lab.calib.actual'), width: 80, render: (r) => pct(r.actual, 1) },
              {
                key: 'gap', label: t('lab.calib.gap'), width: 80,
                value: (r) => r.actual - r.predicted,
                render: (r) => {
                  const d = (r.actual - r.predicted) * 100;
                  return <span className={Math.abs(d) < 3 ? 'pos' : 'neg'}>{signed(d, 1)}</span>;
                },
              },
            ]}
          />
          <p className="note" style={{ marginTop: 10 }}>
            {t('lab.calib.note')}
          </p>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- 误差分析

function ErrorsTab({ meta }) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.labBacktest({ params: meta.defaults }).then(setData).catch(setErr);
  }, [meta]);

  if (err) return <ErrorBox error={err} />;
  if (!data) return <Loading text={t('lab.replaying')} />;

  const sliceName = (r) => t(`srv.lab.slice.${r.key}`);

  return (
    <>
      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <StatTile label={t('lab.errors.overallAcc')} value={pct(data.summary.accuracy, 2)} />
        <StatTile label={t('lab.errors.overallBrier')} value={data.summary.brier.toFixed(4)} />
        <StatTile label={t('lab.errors.hardest')} value={data.slices[0] ? sliceName(data.slices[0]) : '—'} />
        <StatTile label={t('lab.errors.easiest')} value={data.slices.at(-1) ? sliceName(data.slices.at(-1)) : '—'} />
      </div>

      <div className="card">
        <h2>{t('lab.errors.sliceTitle')} <span className="sub">{t('lab.errors.sliceSub')}</span></h2>
        <DataTable
          rows={data.slices}
          rowKey={(r) => r.key}
          initialSort={{ key: 'brierDelta', dir: 'desc' }}
          columns={[
            { key: 'label', label: t('lab.col.gameType'), align: 'left', width: 190, value: sliceName },
            { key: 'n', label: t('lab.col.games'), width: 70 },
            { key: 'accuracy', label: t('lab.col.accuracy'), width: 78, render: (r) => pct(r.accuracy, 1) },
            { key: 'brier', label: 'Brier', width: 74, render: (r) => r.brier.toFixed(4) },
            {
              key: 'brierDelta', label: t('lab.errors.vsOverall'), width: 96,
              render: (r) => (
                <span className={r.brierDelta > 0 ? 'neg' : 'pos'}>
                  {signed(r.brierDelta, 4)} {r.brierDelta > 0 ? t('lab.errors.harder') : t('lab.errors.easier')}
                </span>
              ),
            },
            {
              key: 'marginBias', label: t('lab.marginBias'), width: 86,
              render: (r) => <span className={signClass(-Math.abs(r.marginBias))}>{signed(r.marginBias, 2)}</span>,
            },
          ]}
        />
        <p className="note" style={{ marginTop: 10 }}>
          {t('lab.errors.note1')}<b>{t('lab.marginBias')}</b>{t('lab.errors.note2')}
        </p>
      </div>

      <div className="card">
        <h2>{t('lab.errors.bySeason')}</h2>
        <DataTable
          rows={data.bySeason}
          rowKey={(r) => r.season}
          initialSort={{ key: 'season', dir: 'asc' }}
          columns={[
            { key: 'season', label: t('lab.col.season'), align: 'left', width: 100 },
            { key: 'n', label: t('lab.col.games'), width: 70 },
            { key: 'accuracy', label: t('lab.col.accuracy'), width: 80, render: (r) => pct(r.accuracy, 2) },
            { key: 'brier', label: 'Brier', width: 78, render: (r) => r.brier.toFixed(4) },
            { key: 'marginMae', label: t('lab.col.marginErr'), width: 82, render: (r) => r.marginMae.toFixed(2) },
            {
              key: 'marginBias', label: t('lab.marginBias'), width: 86,
              render: (r) => <span className={Math.abs(r.marginBias) < 0.2 ? 'pos' : 'neg'}>{signed(r.marginBias, 2)}</span>,
            },
          ]}
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- 逐年测量

function MeasureTab({ meta }) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api.labMeasure({}).then(setData).catch(setErr); }, []);

  if (err) return <ErrorBox error={err} />;
  if (!data) return <Loading text={t('lab.measure.measuring')} />;

  const ha = data.homeAdvantage;
  const first = ha[0];
  const last = ha.at(-1);
  const hard = { 0: -1.1, 1: 0, 2: 0.35, 3: 0.5, 4: 0.5 };

  return (
    <>
      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <StatTile label={t('lab.measure.haOf', { season: first?.season })} value={t('lab.pts', { v: first?.homeAdvantage.toFixed(2) })} />
        <StatTile label={t('lab.measure.haOf', { season: last?.season })} value={t('lab.pts', { v: last?.homeAdvantage.toFixed(2) })} />
        <StatTile
          label={t('lab.measure.change')}
          value={signed((last?.homeAdvantage ?? 0) - (first?.homeAdvantage ?? 0), 2)}
          hint={t('lab.measure.changeHint')}
        />
        <StatTile label={t('lab.measure.modelUses')} value={t('lab.pts', { v: meta.defaults.homeAdv })} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>{t('lab.measure.haTitle')} <span className="sub">{t('lab.measure.haSub')}</span></h2>
          <DataTable
            rows={ha}
            rowKey={(r) => r.season}
            initialSort={{ key: 'season', dir: 'asc' }}
            columns={[
              { key: 'season', label: t('lab.col.season'), align: 'left', width: 96 },
              { key: 'n', label: t('lab.col.games'), width: 70 },
              {
                key: 'homeAdvantage', label: t('lab.measure.colHa'), width: 110,
                render: (r) => (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span className="mono" style={{ width: 40, textAlign: 'right' }}>{r.homeAdvantage.toFixed(2)}</span>
                    <span style={{
                      display: 'inline-block', height: 7, borderRadius: 4,
                      width: `${Math.max(2, r.homeAdvantage * 22)}px`,
                      background: 'var(--team-raw)',
                    }}
                    />
                  </span>
                ),
              },
              { key: 'homeWinPct', label: t('lab.measure.colHomeWin'), width: 88, render: (r) => pct(r.homeWinPct, 1) },
            ]}
          />
          <p className="note" style={{ marginTop: 10 }}>
            {t('lab.measure.haNote')}
          </p>
        </div>

        <div className="card">
          <h2>{t('lab.measure.restTitle')} <span className="sub">{t('lab.measure.restSub')}</span></h2>
          <DataTable
            rows={data.rest.map((r) => ({ ...r, hard: hard[r.days] ?? 0.5 }))}
            rowKey={(r) => r.days}
            initialSort={{ key: 'days', dir: 'asc' }}
            columns={[
              {
                key: 'days', label: t('lab.measure.colRest'), align: 'left', width: 88,
                render: (r) => (r.days === 0 ? <span className="neg">{t('lab.measure.b2b')}</span> : t('lab.measure.restDays', { count: r.days })),
              },
              { key: 'n', label: t('lab.measure.colSample'), width: 74 },
              {
                key: 'effect', label: t('lab.measure.colEffect'), width: 90,
                render: (r) => <b className={signClass(r.effect)}>{t('lab.pts', { v: signed(r.effect, 2) })}</b>,
              },
              {
                key: 'hard', label: t('lab.measure.colHard'), width: 84,
                render: (r) => <span className="dim">{signed(r.hard, 2)}</span>,
              },
              {
                key: 'ratio', label: t('lab.measure.colRatio'), width: 84,
                value: (r) => (r.hard ? Math.abs(r.effect / r.hard) : 0),
                render: (r) => (r.hard
                  ? <span className="mono">{(r.effect / r.hard).toFixed(2)}×</span>
                  : <span className="dim">—</span>),
              },
            ]}
          />
          <p className="note" style={{ marginTop: 10 }}>
            {t('lab.measure.restNote1')}<b>{t('lab.measure.shape')}</b>{t('lab.measure.restNote2')}<b>{t('lab.measure.magnitude')}</b>{t('lab.measure.restNote3')}
          </p>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- 反事实

function WhatIfTab({ meta, teams, teamById }) {
  const { t, fmt } = useI18n();
  // 下拉框按当前语言排序；默认球队仍取中文排序的第一支，保证中英文打开同一支
  const sorted = useMemo(() => fmt.sortTeams(teams), [teams, fmt]);
  const defaultTeam = useMemo(() => [...teams].sort((a, b) => a.cn.localeCompare(b.cn, 'zh'))[0], [teams]);
  const [teamId, setTeamId] = useState(defaultTeam?.teamId);
  const [season, setSeason] = useState(meta.seasons.at(-1));
  const [delta, setDelta] = useState(3);
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const run = async () => {
    setBusy(true); setErr(null);
    try {
      setRes(await api.labCounterfactual({ teamId, deltaPts: delta, seasons: [season] }));
    } catch (e) { setErr(e); }
    setBusy(false);
  };

  useEffect(() => { run(); /* eslint-disable-next-line */ }, [teamId, season, delta]);

  const team = teamById.get(teamId);

  return (
    <>
      <ErrorBox error={err} />
      <div className="card">
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <div className="field">
            <label>{t('lab.whatif.team')}</label>
            <select value={teamId} onChange={(e) => setTeamId(Number(e.target.value))} style={{ minWidth: 168 }}>
              {sorted.map((tm) => <option key={tm.teamId} value={tm.teamId}>{fmt.teamName(tm)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>{t('lab.col.season')}</label>
            <select value={season} onChange={(e) => setSeason(e.target.value)}>
              {meta.seasons.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 240 }}>
            <label>{t('lab.whatif.ifPre')}<b className="mono">{signed(delta, 1)}</b>{t('lab.whatif.ifPost')}</label>
            <input
              type="range" min="-8" max="8" step="0.5"
              value={delta}
              onChange={(e) => setDelta(Number(e.target.value))}
            />
          </div>
        </div>
      </div>

      {!res ? <Loading text={busy ? t('lab.whatif.replayingSeason') : t('common.loading')} /> : (
        <>
          <div className="grid cols-4" style={{ marginBottom: 14 }}>
            <div className="tile">
              <div className="k">{t('lab.whatif.team')}</div>
              <div style={{ marginTop: 7 }}>
                <TeamCell team={team} size={28} showAbbr={false} />
              </div>
            </div>
            <StatTile label={t('lab.whatif.baseWins')} value={res.baseExpectedWins} unit={` / ${res.n}`} />
            <StatTile
              label={t('lab.whatif.afterDelta', { delta: signed(delta, 1) })}
              value={res.altExpectedWins}
              unit={` / ${res.n}`}
            />
            <StatTile
              label={t('lab.whatif.winsChange')}
              value={signed(res.winsDelta, 1)}
              hint={t('lab.whatif.flipped', { count: res.flippedGames })}
            />
          </div>

          <div className="card">
            <h2>{t('lab.whatif.convTitle')}</h2>
            <p className="note">
              {t('lab.whatif.conv1', { team: fmt.teamName(team), season })}
              <b>{delta ? Math.abs(res.winsDelta / delta).toFixed(2) : '—'}</b>{t('lab.whatif.conv2')}
            </p>
            <div className="divider" />
            <p className="note">
              <b>{t('lab.whatif.readTitle')}</b>{t('lab.whatif.read1')}<br />
              {t('lab.whatif.read2')}
            </p>
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- 对标盘口

/**
 * 拿模型和博彩收盘盘口正面比。
 *
 * 这一页刻意不做成"看谁赢了"的爽点页。盘口是公开可得的最强对手之一，
 * 拿它当标尺的价值在于知道自己差在哪，而不是自我感觉良好。
 * 所以三块内容都保留了对我们不利的数字。
 */
function MarketTab({ meta }) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!meta.odds?.games) return;
    api.labMarket({ params: meta.defaults }).then(setData).catch(setErr);
  }, [meta]);

  if (!meta.odds?.games) {
    return (
      <div className="card">
        <p className="note">
          {t('lab.market.noOdds1')}<code>npm run odds:history</code>{t('lab.market.noOdds2')}<code>npm run dataset</code>{t('lab.market.noOdds3')}
        </p>
      </div>
    );
  }
  if (err) return <ErrorBox error={err} />;
  if (!data) return <Loading text={t('lab.market.loading')} />;
  if (!data.available) {
    return <div className="card"><p className="note">{t('lab.market.noGames')}</p></div>;
  }

  const { model, marketModel, agreement, ats } = data;
  const books = Object.entries(meta.odds.providers ?? {})
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => t('lab.market.bookGames', { name: k, count: v })).join(t('lab.listSep'));

  return (
    <>
      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <StatTile
          abbr={t('lab.market.abbrModel')} label={t('lab.market.winAcc')} value={pct(model.accuracy)}
          hint={t('lab.market.withLines', { count: data.n })}
        />
        <StatTile
          abbr={t('lab.market.abbrMarket')} label={t('lab.market.winAcc')} value={pct(marketModel.accuracy)}
          hint={t('lab.market.sameGames')}
        />
        <StatTile
          abbr="Δ" label={t('lab.market.gap')} value={signed(data.accuracyGap * 100, 1)} unit=" pp"
          hint={data.mcnemar.significant
            ? t('lab.market.mcSig', { chi2: data.mcnemar.chi2 })
            : t('lab.market.mcNotSig', { chi2: data.mcnemar.chi2 })}
        />
        <StatTile
          abbr="MAE" label={t('lab.market.maeGap')} value={signed(data.maeGap, 2)} unit={t('lab.unit.pts')}
          hint={t('lab.market.maeHint', { model: model.marginMae, market: marketModel.marginMae })}
        />
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h2>{t('lab.market.verdict')} <span className="sub">{t('lab.market.verdictSub')}</span></h2>
        <p className="note" style={{ marginBottom: 10 }}>
          {t('lab.market.v1a', { count: data.n })}<b>{pct(marketModel.accuracy)}</b>{t('lab.market.v1b')}<b>{pct(model.accuracy)}</b>{t('lab.market.v1c', { gap: Math.abs(data.accuracyGap * 100).toFixed(1) })}
          {t('common.sentenceJoin')}
          {data.mcnemar.significant
            ? t('lab.market.sig', { count: data.mcnemar.onlyModel + data.mcnemar.onlyMarket, onlyModel: data.mcnemar.onlyModel, onlyMarket: data.mcnemar.onlyMarket })
            : t('lab.market.notSig')}
        </p>
        <p className="note">
          {t('lab.market.ats1')}<b>{pct(ats.all.rate)}</b>{t('lab.market.ats2', { win: ats.all.win, lose: ats.all.lose, push: ats.all.push })}<b>{pct(ats.breakEven)}</b>{t('lab.market.ats3')}<b>{t('lab.market.atsVerdict')}</b>
          {t('common.sentenceJoin')}
          {t('lab.market.ats4')}
        </p>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>{t('lab.market.whoRight')} <span className="sub">{t('lab.market.disagreeCount', { count: agreement.disagree })}</span></h2>
          <div className="grid cols-3" style={{ marginBottom: 12 }}>
            <StatTile
              label={t('lab.market.agree')} value={agreement.agree} unit={t('common.unit.games', { count: agreement.agree })}
              hint={t('lab.market.agreeAcc', { v: pct(agreement.agreeAccuracy) })}
            />
            <StatTile label={t('lab.market.modelRight')} value={agreement.modelRight} unit={t('common.unit.games', { count: agreement.modelRight })} />
            <StatTile label={t('lab.market.marketRight')} value={agreement.marketRight} unit={t('common.unit.games', { count: agreement.marketRight })} />
          </div>
          <p className="note">
            {t('lab.market.agreeNote', {
              count: agreement.agree,
              acc: pct(agreement.agreeAccuracy),
              rate: pct(agreement.disagreeRate),
              win: pct(agreement.modelWinsWhenDisagree),
            })}
          </p>
        </div>

        <div className="card">
          <h2>{t('lab.market.byEdge')}</h2>
          <DataTable
            rows={ats.byEdge}
            rowKey={(r) => r.key}
            initialSort={{ key: 'label', dir: 'asc' }}
            columns={[
              {
                key: 'label', label: t('lab.market.colEdge'), align: 'left', width: 116,
                value: (r) => EDGE_ORDER.indexOf(r.key),
                render: (r) => t(`srv.lab.edge.${r.key}`),
              },
              { key: 'n', label: t('lab.col.games'), width: 56 },
              {
                key: 'rate', label: t('lab.market.colCover'), width: 76,
                render: (r) => <span className="mono">{pct(r.rate)}</span>,
              },
              {
                key: 'edgeOverBreakEven', label: t('lab.market.colVsBreakEven'), width: 88,
                render: (r) => (
                  <span className={signClass(r.edgeOverBreakEven)}>
                    {signed(r.edgeOverBreakEven * 100, 1)} pp
                  </span>
                ),
              },
            ]}
          />
          <p className="note" style={{ marginTop: 8 }}>
            {t('lab.market.edgeNote')}
          </p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h2>{t('lab.market.byYear')}</h2>
        <DataTable
          rows={data.bySeason}
          rowKey={(r) => r.season}
          initialSort={{ key: 'season', dir: 'asc' }}
          columns={[
            { key: 'season', label: t('lab.col.season'), align: 'left', width: 86 },
            { key: 'n', label: t('lab.col.games'), width: 60 },
            { key: 'modelAccuracy', label: t('lab.market.abbrModel'), width: 70, render: (r) => pct(r.modelAccuracy) },
            { key: 'marketAccuracy', label: t('lab.market.abbrMarket'), width: 70, render: (r) => pct(r.marketAccuracy) },
            {
              key: 'accuracyGap', label: t('lab.market.gap'), width: 104,
              render: (r) => (
                <span className={signClass(r.accuracyGap)}>
                  {signed(r.accuracyGap * 100, 1)} pp
                  {!r.significant && <span className="dim" title={t('lab.market.nsTip')}>{t('lab.market.ns')}</span>}
                </span>
              ),
            },
            { key: 'modelMae', label: t('lab.market.modelMae'), width: 82, render: (r) => num(r.modelMae, 2) },
            { key: 'marketMae', label: t('lab.market.marketMae'), width: 82, render: (r) => num(r.marketMae, 2) },
            { key: 'ats', label: t('lab.market.colCover'), width: 78, render: (r) => pct(r.ats) },
          ]}
        />
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h2>{t('lab.market.gapTitle')} <span className="sub">{t('lab.market.gapSub')}</span></h2>
        <DataTable
          rows={data.gapSlices}
          rowKey={(r) => r.key}
          initialSort={{ key: 'accuracyGap', dir: 'asc' }}
          columns={[
            {
              key: 'label', label: t('lab.col.gameType'), align: 'left', width: 168,
              value: (r) => t(`srv.lab.slice.${r.key}`),
            },
            { key: 'n', label: t('lab.col.games'), width: 60 },
            { key: 'modelAccuracy', label: t('lab.market.abbrModel'), width: 70, render: (r) => pct(r.modelAccuracy) },
            { key: 'marketAccuracy', label: t('lab.market.abbrMarket'), width: 70, render: (r) => pct(r.marketAccuracy) },
            {
              key: 'accuracyGap', label: t('lab.market.accGap'), width: 84,
              render: (r) => (
                <span className={signClass(r.accuracyGap)}>{signed(r.accuracyGap * 100, 1)} pp</span>
              ),
            },
            {
              key: 'maeGap', label: t('lab.market.maeGapCol'), width: 92,
              render: (r) => <span className={signClass(-r.maeGap)}>{signed(r.maeGap, 2)}</span>,
            },
          ]}
        />
        <p className="note" style={{ marginTop: 8 }}>
          {t('lab.market.gapNote')}
        </p>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h2>{t('lab.market.sourceTitle')}</h2>
        <p className="note">
          {t('lab.market.source', { count: meta.odds.games, cov: pct(data.coverage), books: books || '—' })}
        </p>
      </div>
    </>
  );
}
