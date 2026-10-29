import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../App.jsx';
import { useI18n } from '../i18n/react.jsx';
import { renderMsg } from '../i18n/msg.js';
import { api } from '../lib/api.js';
import {
  DataTable, Loading, ErrorBox, Segmented,
} from '../components/common.jsx';
import { LineChart, CiBars, ReliabilityPlot } from '../components/MiniCharts.jsx';
import {
  SCENARIOS, SLIPPAGE_OPTIONS, MODELS, FORWARD_PRIMARY,
  modelOf, splitKeyOf, bookOptions, splitOptions, seasonsOf,
  defaultState, withScenario, withModel, withSplit, toFilters, clvNotApplicable,
} from '../lib/moneylineUi.js';

/**
 * 「模型能否打败市场？」：独赢盘回测与本季前向账本。
 *
 * 规则（spec 五；裁定 M5 等）：
 *   - 默认 = 收盘情景测试期、预选策略（筛选默认值由服务端补全）。
 *   - 历史价格情景模拟（重放模型）与本季前向账本（线上模型、决策时点真实价格）醒目区分，绝不合并。
 *   - 只有预先写定的组合才有结论；exploratory 时显示醒目横幅、不显示结论框。
 *   - 最优价只作敏感性，不当主结果；测试期 2025-26 标「已被看过」；2022-23 标样本内。
 *   - 发给接口的只有 Filters 字段（toFilters）。不提供让分 / 大小分入口。
 */
// eslint-disable-next-line no-unused-vars
export function MoneylineTab({ meta }) {
  const { t } = useI18n();
  const [ml, setMl] = useState(null);
  const [metaErr, setMetaErr] = useState(null);
  useEffect(() => { api.labMoneylineMeta().then(setMl).catch(setMetaErr); }, []);

  if (metaErr) return <ErrorBox error={metaErr} />;
  if (!ml) return <Loading />;
  if (!ml.available) {
    return <div className="card"><p className="note">{t(ml.reasonCode ?? 'srv.ml.reason.noData')}</p></div>;
  }
  return <MoneylineBody ml={ml} />;
}

/** 键存在才翻译，否则原样显示（服务端新增的取值不至于显示成键名） */
const tr = (t, key, raw) => { const v = t(key); return v === key ? String(raw) : v; };

const americanText = (v) => (typeof v === 'number' ? (v > 0 ? `+${v}` : `${v}`) : '—');

function MoneylineBody({ ml }) {
  const { t, fmt } = useI18n();
  const { teamById } = useApp();
  const [state, setState] = useState(defaultState);
  const [view, setView] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dim, setDim] = useState('odds');

  const filters = useMemo(() => toFilters(state), [state]);
  const reqKey = JSON.stringify(filters);
  useEffect(() => {
    let alive = true;
    setBusy(true); setErr(null);
    api.labMoneyline(filters)
      .then((r) => { if (alive) setView(r); })
      .catch((e) => { if (alive) { setErr(e); setView(null); } })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey]);

  const splits = ml.splits;
  const inSample = useMemo(() => new Set((ml.fits ?? []).filter((f) => f.inSample).map((f) => f.season)), [ml]);
  const seasonLabel = (s) => (inSample.has(s) ? t('lab.beat.filter.inSample', { season: s }) : s);
  const bookName = (k) => {
    if (k === 'chain') return t('lab.beat.filter.chain');
    const v = t(`board.book.${k}`);
    return v === `board.book.${k}` ? k : v;
  };
  const familyOf = (id) => (id === FORWARD_PRIMARY ? 'ledger' : (ml.strategies ?? []).find((s) => s.id === id)?.family);
  const strategyName = (id) => {
    const fam = familyOf(id);
    return fam ? `${id} · ${t(`lab.beat.family.${fam}`)}` : id;
  };

  const { scenario } = state;
  const isForward = scenario === 'forward';
  const preselected = isForward ? FORWARD_PRIMARY : (ml.selected?.[splitKeyOf(scenario)] ?? null);
  const strategyIds = [...(isForward ? [FORWARD_PRIMARY] : []), ...(ml.strategies ?? []).map((s) => s.id)];
  const seasonChoices = seasonsOf(scenario, state.split, splits);
  const set = (patch) => setState((s) => ({ ...s, ...patch }));

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <h2>{t('lab.tab.beat')}</h2>
        <p className="note" style={{ marginBottom: 10 }}>{t('lab.beat.intro')}</p>
        <div className="toolbar" style={{ marginBottom: 0, flexWrap: 'wrap' }}>
          <div className="field">
            <label>{t('lab.beat.filter.model')}</label>
            <Segmented
              value={modelOf(scenario)}
              onChange={(m) => setState((s) => withModel(s, m, splits))}
              options={MODELS.map((m) => ({ value: m, label: t(`lab.beat.model.${m}`) }))}
            />
          </div>
          <div className="field">
            <label>{t('lab.beat.filter.scenario')}</label>
            <Segmented
              value={scenario}
              onChange={(v) => setState((s) => withScenario(s, v, splits))}
              options={SCENARIOS.map((v) => ({ value: v, label: t(`lab.beat.scenario.${v}`) }))}
            />
          </div>
          <div className="field">
            <label>{t('lab.beat.filter.split')}</label>
            <Segmented
              value={state.split}
              onChange={(v) => setState((s) => withSplit(s, v, splits))}
              options={splitOptions(scenario).map((v) => ({ value: v, label: t(`lab.beat.split.${v}`) }))}
            />
            {state.split !== 'all' && (
              <span className="note">
                {t('lab.beat.filter.splitSeasons', {
                  name: t(`lab.beat.split.${state.split}`),
                  seasons: seasonsOf(scenario, state.split, splits).map(seasonLabel).join(t('lab.listSep')) || '—',
                })}
              </span>
            )}
          </div>
          <div className="field">
            <label>{t('lab.beat.filter.slippage')}</label>
            <Segmented
              value={state.slippagePts}
              onChange={(v) => set({ slippagePts: v })}
              options={SLIPPAGE_OPTIONS.map((n) => ({ value: n, label: t('lab.beat.filter.slip', { n }) }))}
            />
          </div>
        </div>
        <div className="toolbar" style={{ marginTop: 10, marginBottom: 0, flexWrap: 'wrap' }}>
          <div className="field">
            <label>{t('lab.beat.filter.season')}</label>
            <select value={state.season ?? ''} onChange={(e) => set({ season: e.target.value || null })}>
              <option value="">{t('lab.beat.filter.allSeasons')}</option>
              {seasonChoices.map((s) => <option key={s} value={s}>{seasonLabel(s)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>{t('lab.beat.filter.from')}</label>
            <input type="date" value={state.from ?? ''} onChange={(e) => set({ from: e.target.value || null })} />
          </div>
          <div className="field">
            <label>{t('lab.beat.filter.to')}</label>
            <input type="date" value={state.to ?? ''} onChange={(e) => set({ to: e.target.value || null })} />
          </div>
          <div className="field">
            <label>{t('lab.beat.filter.book')}</label>
            <select value={state.book} disabled={scenario === 'closeBest'} onChange={(e) => set({ book: e.target.value })}>
              {bookOptions(scenario, ml.books).map((b) => <option key={b} value={b}>{bookName(b)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>{t('lab.beat.filter.strategy')}</label>
            <select value={state.strategy ?? ''} onChange={(e) => set({ strategy: e.target.value || null })}>
              <option value="">
                {preselected ? t('lab.beat.filter.defaultStrategy', { id: preselected }) : t('lab.beat.filter.noStrategy')}
              </option>
              {strategyIds.map((id) => <option key={id} value={id}>{strategyName(id)}</option>)}
            </select>
          </div>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setState(defaultState())}>{t('lab.beat.filter.reset')}</button>
          </div>
        </div>
      </div>

      <SourceBar ml={ml} scenario={scenario} view={view} />

      <ErrorBox error={err} />
      {!view && !err && <Loading text={t('lab.replaying')} />}
      {busy && view && <div className="note" style={{ marginBottom: 8 }}>{t('lab.replaying')}</div>}
      {view && view.available === false && (
        <div className="card">
          <p className="note">{t('lab.beat.forwardUnavailable', { reason: t(view.reasonCode ?? 'srv.reason.ledgerUnavailable') })}</p>
        </div>
      )}
      {view && view.available !== false && view.summary && (
        <Result view={view} dim={dim} setDim={setDim} teamById={teamById} strategyName={strategyName} bookName={bookName} seasonLabel={seasonLabel} />
      )}
    </>
  );
}

// ---------------------------------------------------------------- 数据来源条

function SourceBar({ ml, scenario, view }) {
  const { t, fmt } = useI18n();
  const isForward = scenario === 'forward';
  const fwd = ml.forward ?? {};
  const labels = view?.labels;
  const cov = view?.coverage;
  const box = (active) => ({
    flex: '1 1 260px',
    padding: '10px 13px',
    borderRadius: 'var(--radius-sm)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
    background: active ? 'var(--glass)' : 'transparent',
    opacity: active ? 1 : 0.55,
  });
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div style={box(!isForward)}>
          <b>{t('lab.beat.source.historical')}</b>
          <div className="note">{t('lab.beat.source.historicalSub')}</div>
          {!isForward && (
            <div className="note">
              {t(`lab.beat.source.priceAt.${scenario}`)}
              {' · '}{t('lab.beat.source.modelTag', { v: labels?.modelVersion ?? 'replay-elo-wf' })}
              {cov && cov.total != null && <>{' · '}{t('lab.beat.source.coverage', { priced: cov.priced, total: cov.total })}</>}
              {ml.builtAt && <>{' · '}{t('lab.beat.source.builtAt', { date: fmt.date(String(ml.builtAt).slice(0, 10)) })}</>}
            </div>
          )}
        </div>
        <div style={box(isForward)}>
          <b>{t('lab.beat.source.forward')}</b>
          <div className="note">{t('lab.beat.source.forwardSub')}</div>
          {isForward && (
            <div className="note">
              {t('lab.beat.source.priceAt.forward')}
              {' · '}{t('lab.beat.source.modelTag', { v: labels?.modelVersion ?? 'production-logged' })}
              {fwd.available && <>{' · '}{t('lab.beat.source.forwardCounts', { captured: fwd.captured ?? 0, pending: fwd.pending ?? 0 })}</>}
              {fwd.available && fwd.unmatched > 0 && <>{' · '}{t('lab.beat.source.forwardUnmatched', { n: fwd.unmatched })}</>}
              {labels?.forwardBasis && <>{' · '}{t(`lab.beat.source.basis.${labels.forwardBasis}`)}</>}
            </div>
          )}
        </div>
      </div>
      {!isForward && labels?.previouslySeen && (
        <div className="warn-box" style={{ marginTop: 10, marginBottom: 0 }}><b>{t('lab.beat.source.previouslySeen')}</b></div>
      )}
      {scenario === 'closeBest' && (
        <div className="warn-box" style={{ marginTop: 10, marginBottom: 0 }}><b>{t('lab.beat.source.bestPrice')}</b></div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 结果

function Tile({ label, value, unit, sub, className }) {
  return (
    <div className="tile">
      <div className="k">{label}</div>
      <div className={`v ${className ?? ''}`}>
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {sub && <div className="note" style={{ marginTop: 4, lineHeight: 1.45 }}>{sub}</div>}
    </div>
  );
}

const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

function Result({ view, dim, setDim, teamById, strategyName, bookName, seasonLabel }) {
  const { t, fmt } = useI18n();
  const s = view.summary;
  const ciDay = view.ci?.day?.roi ?? null;
  const scenario = view.filters?.scenario;
  const units = t('lab.beat.unit.units');
  const dd = s.maxDrawdown ?? {};
  const pctCi = (c) => (c?.lo == null ? '—' : `[${fmt.pct(c.lo, 1)}, ${fmt.pct(c.hi, 1)}]`);
  const pp = (v) => (v == null ? '—' : `${fmt.signed(v * 100, 1)} pp`);

  let clvValue; let clvSub;
  if (clvNotApplicable(scenario)) { clvValue = t('lab.beat.tile.clvNA'); clvSub = t('lab.beat.tile.clvNAHint'); } else if (s.clv) {
    clvValue = pp(s.clv.mean);
    clvSub = t('lab.beat.tile.clvHint', { n: s.clv.n, beat: fmt.pct(s.clv.beatClose, 0) });
  } else { clvValue = '—'; }

  const strategyRows = (view.strategies ?? []).map((r) => ({
    key: r.id,
    label: r.id,
    value: r.roi,
    lo: r.ci?.lo ?? null,
    hi: r.ci?.hi ?? null,
    tag: r.id === view.selected ? t('lab.beat.chart.selected') : r.family === 'A' ? t('lab.beat.chart.baseline') : null,
    emphasis: r.id === view.strategy ? 'selected' : null,
  }));
  const edgeLabel = (k) => (k === '<0' ? '<0%' : k === '10+' ? '≥10%' : k === 'n/a' ? t('lab.beat.bucket.key.na') : `${k.replace('-', '–')}%`);
  const edgeRows = (view.buckets?.edge ?? []).map((b) => ({
    key: b.key, label: edgeLabel(b.key), value: b.roi, lo: b.ci?.lo ?? null, hi: b.ci?.hi ?? null, tag: `n ${b.n}`,
  }));
  const cal = view.calibration ?? {};
  // 「已被看过」与「最优价」已在数据来源条上醒目显示，警告列表里不重复
  const shownInSource = new Set([
    ...(view.labels?.previouslySeen ? ['srv.ml.warn.previouslySeen'] : []),
    ...(scenario === 'closeBest' ? ['srv.ml.warn.bestPrice'] : []),
  ]);
  const warnings = (view.warnings ?? []).filter((w) => !shownInSource.has(w.code));

  const bucketLabel = (d, k) => {
    if (k === 'n/a') return t('lab.beat.bucket.key.na');
    if (d === 'odds') return k;
    if (d === 'prob') return `${k.replace('-', '–')}%`;
    return t(`lab.beat.bucket.key.${k}`);
  };
  const bucketRows = (view.buckets?.[dim] ?? []).map((b, i) => ({ ...b, idx: i }));

  const team = (id) => teamById?.get(id)?.abbr ?? String(id);
  const mc = view.multipleComparisons ?? {};
  const pw = view.power ?? {};

  return (
    <>
      {warnings.length > 0 && (
        <div className="warn-box">
          {warnings.map((w) => <div key={w.code}>{renderMsg(w, t)}</div>)}
        </div>
      )}

      {view.exploratory && (
        <div className="warn-box" role="status" data-testid="ml-exploratory" style={{ borderLeft: '4px solid var(--warn)', fontSize: 14 }}>
          <b>{t('lab.beat.exploratory')}</b>
        </div>
      )}
      {view.verdict && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>{t('lab.beat.verdictTitle')}</h2>
          <p style={{ fontSize: 15, fontWeight: 650, margin: '4px 0 8px' }}>{renderMsg(view.verdict, t)}</p>
          <p className="note">{t('lab.beat.verdictRule', { min: view.verdict.params?.min ?? 300 })}</p>
        </div>
      )}

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <Tile label={t('lab.beat.tile.bets')} value={fmt.num(s.bets, 0)} sub={view.strategy ? strategyName(view.strategy) : null} />
        <Tile label={t('lab.beat.tile.staked')} value={fmt.num(s.staked, 1)} unit={units} />
        <Tile label={t('lab.beat.tile.profit')} value={fmt.signed(s.profit, 1)} unit={units} className={sign(s.profit)} />
        <Tile
          label={t('lab.beat.tile.roi')} value={fmt.pct(s.roi, 1)} className={sign(s.roi)}
          sub={ciDay ? t('lab.beat.tile.roiHint', { lo: fmt.pct(ciDay.lo, 1), hi: fmt.pct(ciDay.hi, 1) }) : t('lab.beat.tile.roiNoCi')}
        />
        <Tile label={t('lab.beat.tile.hitRate')} value={fmt.pct(s.hitRate, 1)} sub={t('lab.beat.tile.hitHint', { wins: s.wins, losses: s.losses })} />
        <Tile
          label={t('lab.beat.tile.drawdown')} value={fmt.num(dd.units, 1)} unit={units}
          sub={t(dd.recovered === false ? 'lab.beat.tile.drawdownOpen' : 'lab.beat.tile.drawdownHint', { days: dd.days ?? 0, bets: dd.bets ?? 0 })}
        />
        <Tile label={t('lab.beat.tile.clv')} value={clvValue} sub={clvSub} />
      </div>

      {s.bets === 0 && <div className="card"><div className="empty">{t('lab.beat.empty')}</div></div>}

      <div className="grid cols-2" style={{ marginBottom: 14 }}>
        <div className="card">
          <h2>{t('lab.beat.chart.curve')} <span className="sub">{t('lab.beat.chart.curveSub')}</span></h2>
          <LineChart
            label={t('lab.beat.chart.curve')}
            baseline={100}
            points={(s.curve ?? []).map((p) => ({ date: p.date, value: p.bankroll }))}
          />
        </div>
        <div className="card">
          <h2>{t('lab.beat.chart.roi')} <span className="sub">{t('lab.beat.chart.roiSub')}</span></h2>
          <CiBars label={t('lab.beat.chart.roi')} rows={strategyRows} />
        </div>
        <div className="card">
          <h2>{t('lab.beat.chart.edge')} <span className="sub">{t('lab.beat.chart.edgeSub')}</span></h2>
          <CiBars label={t('lab.beat.chart.edge')} rows={edgeRows} />
        </div>
        <div className="card">
          <h2>
            {t('lab.beat.chart.calib')}
            {cal.n > 0 && (
              <span className="sub">
                {t('lab.beat.chart.calibSub', { n: cal.n, model: fmt.num(cal.model?.brier, 4), market: fmt.num(cal.market?.brier, 4) })}
              </span>
            )}
          </h2>
          <ReliabilityPlot label={t('lab.beat.chart.calib')} model={cal.reliability?.model} market={cal.reliability?.market} />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h2>{t('lab.beat.bucket.title')} <span className="sub">{t('lab.beat.bucket.sub')}</span></h2>
        <div style={{ marginBottom: 10 }}>
          <Segmented
            value={dim} onChange={setDim}
            options={['odds', 'prob', 'homeAway', 'b2b', 'phase'].map((d) => ({ value: d, label: t(`lab.beat.bucket.dim.${d}`) }))}
          />
        </div>
        <DataTable
          rows={bucketRows}
          rowKey={(r) => r.key}
          initialSort={{ key: 'bucket', dir: 'asc' }}
          columns={[
            { key: 'bucket', label: t('lab.beat.bucket.col.bucket'), align: 'left', width: 170, value: (r) => r.idx, render: (r) => bucketLabel(dim, r.key) },
            { key: 'n', label: t('lab.beat.bucket.col.n'), width: 64 },
            { key: 'roi', label: t('lab.beat.bucket.col.roi'), width: 80, render: (r) => <span className={sign(r.roi)}>{fmt.pct(r.roi, 1)}</span> },
            { key: 'ci', label: t('lab.beat.bucket.col.ci'), width: 140, value: (r) => r.ci?.lo ?? null, render: (r) => <span className="mono">{pctCi(r.ci)}</span> },
            { key: 'hitRate', label: t('lab.beat.bucket.col.hitRate'), width: 80, render: (r) => fmt.pct(r.hitRate, 1) },
          ]}
        />
      </div>

      <div className="grid cols-2" style={{ marginBottom: 14 }}>
        <div className="card">
          <h2>{t('lab.beat.power.title')}</h2>
          <p className="note">
            {pw.sd == null ? t('lab.beat.power.none')
              : pw.needed != null ? t('lab.beat.power.needed', { n: fmt.num(pw.needed, 0), bets: s.bets })
                : t('lab.beat.power.never', {
                  n1: fmt.num(pw.neededAt?.['0.01'], 0), n2: fmt.num(pw.neededAt?.['0.02'], 0), n3: fmt.num(pw.neededAt?.['0.03'], 0),
                })}
          </p>
        </div>
        <div className="card">
          <h2>{t('lab.beat.mc.title')}</h2>
          {scenario === 'forward' ? (
            <p className="note">{t('lab.beat.mc.forward')}</p>
          ) : (
            <>
              <p className="note">
                {t('lab.beat.mc.body', {
                  split: mc.selectOn ? t(`lab.beat.split.${mc.selectOn}`) : '—',
                  seasons: (mc.seasons ?? []).map(seasonLabel).join(t('lab.listSep')) || '—',
                  tried: mc.tried ?? 0,
                  alpha: fmt.num(mc.bonferroniAlpha, 4),
                })}
                {mc.selected == null && <>{' '}{t('lab.beat.mc.selectedNone')}</>}
              </p>
              <DataTable
                rows={mc.rows ?? []}
                rowKey={(r) => `${r.id}|${r.split}`}
                initialSort={{ key: 'roi', dir: 'desc' }}
                columns={[
                  { key: 'id', label: t('lab.beat.mc.col.id'), align: 'left', width: 110 },
                  { key: 'bets', label: t('lab.beat.mc.col.bets'), width: 64 },
                  { key: 'roi', label: t('lab.beat.mc.col.roi'), width: 76, render: (r) => <span className={sign(r.roi)}>{fmt.pct(r.roi, 1)}</span> },
                  { key: 'chosen', label: t('lab.beat.mc.col.chosen'), width: 84, value: (r) => (r.id === mc.selected ? 1 : 0), render: (r) => (r.id === mc.selected ? t('lab.beat.mc.chosen') : '') },
                ]}
              />
            </>
          )}
        </div>
      </div>

      <div className="card">
        <h2>{t('lab.beat.bets.title')} <span className="sub">{t('lab.beat.bets.sub', { n: (view.bets ?? []).length })}</span></h2>
        {(view.bets ?? []).length === 0 ? <div className="empty">{t('lab.beat.empty')}</div> : (
          <DataTable
            rows={view.bets.map((b, i) => ({ ...b, idx: i }))}
            rowKey={(r) => `${r.gameId}|${r.idx}`}
            initialSort={{ key: 'date', dir: 'desc' }}
            maxHeight={420}
            columns={[
              { key: 'date', label: t('lab.beat.bets.col.date'), align: 'left', width: 90, value: (r) => r.idx, render: (r) => fmt.dateShort(r.date) },
              { key: 'matchup', label: t('lab.beat.bets.col.matchup'), align: 'left', width: 96, value: (r) => `${team(r.awayId)}@${team(r.homeId)}`, render: (r) => t('lab.beat.bets.matchup', { away: team(r.awayId), home: team(r.homeId) }) },
              { key: 'side', label: t('lab.beat.bets.col.side'), width: 56, render: (r) => tr(t, `lab.beat.bets.side.${r.side}`, r.side) },
              { key: 'priceAt', label: t('lab.beat.bets.col.priceAt'), width: 70, render: (r) => (r.priceAt ? tr(t, `lab.beat.bets.priceAt.${r.priceAt}`, r.priceAt) : '—') },
              { key: 'book', label: t('lab.beat.bets.col.book'), width: 90, render: (r) => (r.book ? bookName(r.book) : '—') },
              { key: 'pModel', label: t('lab.beat.bets.col.p'), width: 70, render: (r) => fmt.pct(r.pModel, 1) },
              { key: 'american', label: t('lab.beat.bets.col.odds'), width: 64, render: (r) => <span className="mono">{americanText(r.american)}</span> },
              { key: 'stake', label: t('lab.beat.bets.col.stake'), width: 64, render: (r) => fmt.num(r.stake, 2) },
              { key: 'result', label: t('lab.beat.bets.col.result'), width: 56, render: (r) => tr(t, `lab.beat.bets.result.${r.result}`, r.result) },
              { key: 'profit', label: t('lab.beat.bets.col.profit'), width: 72, render: (r) => <span className={sign(r.profit)}>{fmt.signed(r.profit, 2)}</span> },
              { key: 'clv', label: t('lab.beat.bets.col.clv'), width: 70, render: (r) => pp(r.clv) },
              { key: 'version', label: t('lab.beat.bets.col.version'), align: 'left', width: 170, value: (r) => `${r.modelVersion}/${r.paramsVersion}`, render: (r) => <span className="mono" style={{ fontSize: 11 }}>{r.modelVersion} / {r.paramsVersion}</span> },
            ]}
          />
        )}
      </div>
    </>
  );
}
