import React, { useEffect, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { useI18n } from '../i18n/react.jsx';
import { renderMsg } from '../i18n/msg.js';
import { api, withOut } from '../lib/api.js';
import {
  TeamCell, Loading, ErrorBox, ProbBar, StatTile, Segmented, DataTable,
} from '../components/common.jsx';
import { probColor, pct, num, signed } from '../lib/format.js';

const tabs = (t) => ['stats', 'done', 'next', 'bet'].map((value) => ({ value, label: t(`board.tab.${value}`) }));

const ci = (c) => (c?.lo == null ? '—' : `${pct(c.lo, 0)} – ${pct(c.hi, 0)}`);
const roi = (v) => (v == null ? '—' : `${signed(v * 100)}%`);

/** 主队胜率：和赛程页同一个样子 */
const Prob = ({ p }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
    <ProbBar p={p} width={52} />
    <b className="mono" style={{ color: probColor(p) }}>{(p * 100).toFixed(0)}%</b>
  </span>
);

const Hit = ({ hit }) => {
  const { t } = useI18n();
  return <span className={`chip ${hit ? 'hit' : 'miss'}`}>{hit ? t('board.hit') : t('board.miss')}</span>;
};

/** 小表：rows 的每列由 cols 给出 [表头, 取值函数, 是否左对齐] */
function Mini({ cols, rows, rowKey = (r, i) => i }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr>{cols.map(([h, , left]) => <th key={h} className={left ? 'left' : ''}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey(r, i)}>
              {cols.map(([h, f, left]) => <td key={h} className={left ? 'left' : 'mono'}>{f(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GamesTable({ games, teamById, showMarket, upcoming }) {
  const { t, fmt } = useI18n();
  return (
    <div className="table-wrap" style={{ maxHeight: 700, overflowY: 'auto' }}>
      <table className="data">
        <thead>
          <tr>
            <th className="left" style={{ width: 112 }}>{t('board.col.date')}</th>
            <th className="left" style={{ width: 184 }}>{t('board.col.away')}</th>
            <th className="left" style={{ width: 184 }}>{t('board.col.home')}</th>
            <th style={{ width: 122 }}>{t('board.col.homeProb')}</th>
            <th style={{ width: 84 }}>{t('board.col.predScore')}</th>
            {!upcoming && <th style={{ width: 118 }} title={t('board.col.actualTip')}>{t('board.col.actual')}</th>}
            {upcoming && <th className="left" style={{ width: 150 }}>{t('board.col.pick')}</th>}
            {showMarket && <th style={{ width: 96 }} title={t('board.col.marketTip')}>{t('board.col.market')}</th>}
          </tr>
        </thead>
        <tbody>
          {games.map((g, i) => {
            const p = g.prediction.homeWinProb;
            return (
              <tr key={g.gameId} className="clickable" onClick={() => go(`predict/${g.awayId}/${g.homeId}/${g.gameId}`)}>
                <td className="left sched-date">{i === 0 || games[i - 1].date !== g.date ? fmt.date(g.date) : ''}</td>
                <td className="left"><TeamCell team={teamById.get(g.awayId)} size={20} showAbbr={false} /></td>
                <td className="left"><TeamCell team={teamById.get(g.homeId)} size={20} showAbbr={false} /></td>
                <td><Prob p={p} /></td>
                <td className={upcoming ? 'mono' : 'mono dim'}>
                  {g.prediction.awayScore.toFixed(0)} - {g.prediction.homeScore.toFixed(0)}
                </td>
                {!upcoming && <td className="mono"><b>{g.awayScore} - {g.homeScore}</b> <Hit hit={g.hit} /></td>}
                {upcoming && (
                  <td className="left">
                    {fmt.teamName(teamById.get(p >= 0.5 ? g.homeId : g.awayId))}{' '}
                    <span className="dim mono">{pct(Math.max(p, 1 - p), 0)}</span>
                  </td>
                )}
                {showMarket && <td className="mono">{g.market?.homeProb != null ? pct(g.market.homeProb, 0) : '—'}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
      {games.length === 0 && <div className="empty">{t('board.noGames')}</div>}
    </div>
  );
}

function Stats({ d, teamById }) {
  const { t, fmt } = useI18n();
  const tn = (id) => fmt.teamName(teamById.get(id));
  const teamRows = d.byTeam.map((t) => ({ ...t, team: teamById.get(t.key) }));
  return (
    <>
      <div className="grid cols-2">
        <div className="card">
          <h2>{t('board.stats.baselines')}<span className="sub">{t('board.stats.baselinesSub', { n: d.overall.n })}</span></h2>
          <Mini
            rowKey={(r) => r.key}
            rows={d.baselines}
            cols={[
              [t('board.stats.method'), (r) => (r.key === 'model' ? <b>{t(`srv.board.baseline.${r.key}`)}</b> : t(`srv.board.baseline.${r.key}`)), true],
              [t('board.stats.hitsN'), (r) => `${r.hits} / ${r.n}`],
              [t('board.stats.acc'), (r) => pct(r.acc)],
              [t('board.ci95'), (r) => ci(r.ci)],
            ]}
          />
        </div>
        <div className="card">
          <h2>{t('board.stats.errors')}<span className="sub">{t('board.stats.errorsSub', { n: d.errors.n })}</span></h2>
          <Mini
            rows={[
              ['Brier', num(d.overall.brier, 3), t('board.stats.coinBrier')],
              [t('board.stats.logLoss'), num(d.overall.logLoss, 3), t('board.stats.coinLogLoss')],
              [t('board.stats.marginMae'), t('board.pts', { v: num(d.errors.marginMae) }), t('board.stats.marginBias', { v: signed(d.errors.marginBias) })],
              [t('board.stats.totalMae'), t('board.pts', { v: num(d.errors.totalMae) }), t('board.stats.totalBias', { v: signed(d.errors.totalBias) })],
              [t('board.stats.scoreMae'), t('board.pts', { v: num(d.errors.scoreMae) }), t('board.stats.scoreMaeNote')],
            ]}
            cols={[[t('board.stats.metric'), (r) => r[0], true], [t('board.stats.value'), (r) => r[1]], [t('board.stats.note'), (r) => <span className="dim">{r[2]}</span>, true]]}
          />
        </div>
      </div>

      <div className="card">
        <h2>{t('board.stats.calib')}<span className="sub">{t('board.stats.calibSub')}</span></h2>
        <Mini
          rowKey={(r) => r.label}
          rows={d.buckets}
          cols={[
            [t('board.stats.conf'), (r) => r.label, true],
            [t('board.stats.games'), (r) => r.n],
            [t('board.stats.predAvg'), (r) => pct(r.conf)],
            [t('board.stats.actualHits'), (r) => (r.n ? <span style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}><ProbBar p={r.acc} width={52} />{t('board.stats.hitsGames', { n: r.hits })} · {pct(r.acc)}</span> : '—')],
          ]}
        />
      </div>

      <div className="grid cols-3" style={{ marginTop: 14 }}>
        {d.splits.map((s) => (
          <div className="card" key={s.key}>
            <h2>{t(`srv.board.splitGroup.${s.key}`)}</h2>
            <Mini
              rowKey={(r) => r.key}
              rows={s.rows}
              cols={[
                ['', (r) => t(`srv.board.split.${r.key}`), true],
                [t('board.stats.hitsN'), (r) => `${r.hits} / ${r.n}`],
                [t('board.stats.acc'), (r) => pct(r.acc, 0)],
              ]}
            />
          </div>
        ))}
      </div>

      <div className="card">
        <h2>{t('board.stats.misses')}<span className="sub">{t('board.stats.missesSub', { n: d.misses.length })}</span></h2>
        <Mini
          rowKey={(r) => r.gameId}
          rows={d.misses}
          cols={[
            [t('board.col.date'), (r) => fmt.date(r.date), true],
            [t('board.col.matchup'), (r) => `${tn(r.awayId)} @ ${tn(r.homeId)}`, true],
            [t('board.stats.ourPick'), (r) => `${tn(r.p >= 0.5 ? r.homeId : r.awayId)} ${pct(r.conf, 0)}`, true],
            [t('board.stats.actual'), (r) => `${r.awayScore} - ${r.homeScore}`],
          ]}
        />
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>{t('board.stats.byDate')}<span className="sub">{t('board.stats.byDateSub')}</span></h2>
          <Mini
            rowKey={(r) => r.key}
            rows={d.byDate}
            cols={[
              [t('board.col.date'), (r) => fmt.dateShort(r.key), true],
              [t('board.stats.day'), (r) => `${r.hits} / ${r.n}`],
              [t('board.stats.cum'), (r) => `${r.cumHits} / ${r.cumN}`],
              [t('board.stats.cumAcc'), (r) => <span style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}><ProbBar p={r.cumAcc} width={52} />{pct(r.cumAcc)}</span>],
            ]}
          />
        </div>
        <div className="card">
          <h2>{t('board.stats.byTeam')}<span className="sub">{t('board.stats.byTeamSub')}</span></h2>
          <DataTable
            rows={teamRows}
            rowKey={(r) => r.key}
            maxHeight={420}
            initialSort={{ key: 'acc', dir: 'desc' }}
            onRowClick={(r) => go(`team/${r.key}`)}
            columns={[
              { key: 'team', label: t('board.col.team'), align: 'left', value: (r) => (r.team ? fmt.teamName(r.team) : ''), render: (r) => <TeamCell team={r.team} size={20} showAbbr={false} /> },
              { key: 'n', label: t('board.stats.games') },
              { key: 'hits', label: t('board.stats.hits') },
              { key: 'acc', label: t('board.stats.acc'), render: (r) => pct(r.acc, 0) },
            ]}
          />
        </div>
      </div>

      <ShadowCard />
    </>
  );
}

// 方案名取 board.shadow.variant.<variant>；未知方案原样显示 id
const SHADOW_VARIANTS = ['base', 'r22', 'r0630', 'rr22', 'rr0630'];
const d4 = (c) => (c ? `${c.mean >= 0 ? '+' : ''}${c.mean.toFixed(4)} [${c.lo.toFixed(4)}, ${c.hi.toFixed(4)}]` : '—');

/** 影子运行：伤病报告三套 + 阵容+战绩榜两套，只记录、不影响页面显示的预测（scripts/shadow.mjs） */
function ShadowCard() {
  const { t } = useI18n();
  const [s, setS] = useState(null);
  useEffect(() => { api.shadow().then(setS).catch(() => setS({ available: false })); }, []);
  if (!s?.available) return null;
  return (
    <div className="card">
      <h2>{t('board.shadow.title')}
        <span className="sub">{t('board.shadow.sub', { progress: s.progress, target: s.target })}
          {s.rrProgress != null ? t('board.shadow.subRr', { n: s.rrProgress, target: s.target }) : ''}{s.pending ? t('board.shadow.subPending', { n: s.pending }) : ''}</span>
      </h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 10px' }}>
        <ProbBar p={Math.min(1, s.progress / s.target)} width={160} />
        <span className="dim">{t('board.shadow.rule', { target: s.target })}</span>
      </div>
      <Mini
        rowKey={(r) => r.variant}
        rows={s.variants}
        cols={[
          [t('board.shadow.variantCol'), (r) => (SHADOW_VARIANTS.includes(r.variant) ? t(`board.shadow.variant.${r.variant}`) : r.variant), true],
          [t('board.shadow.settled'), (r) => r.n],
          [t('board.stats.logLoss'), (r) => num(r.logLoss, 4)],
          ['Brier', (r) => num(r.brier, 4)],
          [t('board.shadow.dLogLoss'), (r) => (r.variant === 'base' ? '—' : d4(r.dLogLoss))],
          ['Δ Brier', (r) => (r.variant === 'base' ? '—' : d4(r.dBrier))],
          [t('board.shadow.progress'), (r) => (r.variant === 'base' ? '—' : (
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <ProbBar p={Math.min(1, (r.paired ?? 0) / s.target)} width={48} />{r.paired ?? 0} / {s.target}
            </span>
          ))],
        ]}
      />
      <p className="dim" style={{ marginTop: 8 }}>
        {t('board.shadow.note1')}
      </p>
      <p className="dim" style={{ marginTop: 4 }}>
        {t('board.shadow.note2')}
      </p>
    </div>
  );
}

/** 累计盈亏曲线（单位：注）。横轴按下注顺序，纵轴自适应并画出 0 线 */
function Curve({ points, label }) {
  const { t, fmt } = useI18n();
  if (points.length < 2) return <div className="empty">{t('board.curve.tooFew')}</div>;
  const W = 600; const H = 150; const P = 8;
  const ys = points.map((p) => p.units);
  const lo = Math.min(0, ...ys); const hi = Math.max(0, ...ys);
  const x = (i) => P + (i * (W - 2 * P)) / (points.length - 1);
  const y = (v) => P + ((hi - v) / (hi - lo || 1)) * (H - 2 * P);
  const last = ys.at(-1);
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}
        style={{ width: '100%', height: H, display: 'block' }}>
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="var(--text-faint)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        <polyline fill="none" stroke={last >= 0 ? 'var(--good)' : 'var(--bad)'} strokeWidth="2" vectorEffect="non-scaling-stroke"
          points={points.map((p, i) => `${x(i).toFixed(1)},${y(p.units).toFixed(1)}`).join(' ')} />
      </svg>
      <div className="note" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span>{fmt.dateShort(points[0].date)} → {fmt.dateShort(points.at(-1).date)}</span>
        <span>{t('board.curve.range', { hi: signed(hi), lo: signed(lo) })}<b className={last >= 0 ? 'pos' : 'neg'}>{t('board.unitsVal', { v: signed(last) })}</b></span>
      </div>
    </>
  );
}

const thr = (t) => `≥ ${pct(t, 0)}`;
const ciRoi = (c) => (c?.lo == null ? '—' : `${roi(c.lo)} ~ ${roi(c.hi)}`);
const MIN_LEDGER = 100;

function PaperBetting({ teamById }) {
  const { t, fmt } = useI18n();
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [season, setSeason] = useState('all');
  useEffect(() => { api.paper().then(setD).catch(setErr); }, []);
  if (err) return <ErrorBox error={err} />;
  if (!d) return <Loading />;
  const { backtest: bt, ledger: lg } = d;
  // 博彩商名按 id 取 board.book.<id>（不用数据文件里的中文名）；未知 id 原样显示
  const name = (k) => { const v = t(`board.book.${k}`); return v === `board.book.${k}` ? k : v; };
  const team = (id) => (teamById.get(id) ? fmt.teamName(teamById.get(id)) : id);
  const main = lg.available ? lg.rules.find((r) => !r.late && r.threshold === (bt?.rules?.primary ?? 0.03)) ?? lg.rules[1] : null;
  const late = lg.available ? lg.rules.find((r) => r.late) : null;
  const pair = [main, late].filter(Boolean);

  const seasons = bt ? Object.keys(bt.coverage) : [];
  const books = bt ? [...new Set(bt.table.map((r) => r.book))].sort((a, b) => (a === 'draftkings' ? -1 : b === 'draftkings' ? 1 : a === 'best' ? 1 : b === 'best' ? -1 : 0)) : [];
  const rowsFor = (book) => bt.table.filter((r) => r.book === book
    && (season === 'all' ? (r.season === 'all' || !bt.table.some((x) => x.book === book && x.season === 'all')) : r.season === season));
  const tableRows = books.flatMap(rowsFor);

  return (
    <>
      <div className="warn-box">
        <p style={{ margin: '2px 0' }}><b>{bt ? renderMsg(bt.headline.verdictMsg, t) : t('board.paper.noBacktest')}</b></p>
        <p style={{ margin: '2px 0' }}>
          {t('board.paper.disclaimer')}
        </p>
      </div>

      {bt && (
        <div className="grid cols-5" style={{ margin: '14px 0' }}>
          <StatTile label={t('board.paper.oosBets')} value={bt.headline.bets} hint={bt.headline.seasons.join(' / ') || '—'} />
          <StatTile label="ROI" value={roi(bt.headline.roi)} hint={t('board.ciVal', { v: ciRoi(bt.headline.ci) })} />
          <StatTile label={t('board.paper.winRate')} value={`${pct(bt.headline.winRate)} / ${pct(bt.headline.breakEven)}`} hint={t('board.paper.winRateHint')} />
          <StatTile label={t('board.paper.units')} value={signed(bt.headline.units)} unit={t('board.unit')} hint={t('board.paper.unitsHint')} />
          <StatTile label={t('board.paper.maxDd')} value={num(bt.headline.maxDrawdown)} unit={t('board.unit')} hint={t('board.paper.maxDdHint')} />
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <h2>{t('board.paper.btCurve')}<span className="sub">{t('board.paper.btCurveSub')}</span></h2>
          {bt ? <Curve points={bt.headline.curve} label={t('board.paper.btCurveLabel')} /> : <div className="empty">{t('board.paper.noBt')}</div>}
        </div>
        <div className="card">
          <h2>{t('board.ledger.curve')}<span className="sub">{t('board.ledger.curveSub')}</span></h2>
          {main ? <Curve points={main.curve} label={t('board.ledger.curveLabel')} /> : <div className="empty">{t(lg.reasonCode ?? 'board.ledger.none')}</div>}
          {main && (
            <p className="note">
              {t('board.ledger.settledPre')}<b>{main.bets}</b>{t('board.ledger.settledPost', { pending: main.pending, first: lg.firstDate ?? '—', captured: lg.captured })}
              {main.bets < MIN_LEDGER
                ? t('board.ledger.small', { n: main.bets })
                : t('board.ledger.roi', { roi: roi(main.roi), ci: ciRoi(main.ci) })}
            </p>
          )}
        </div>
      </div>

      {main && (
        <div className="card">
          <h2>{t('board.ledger.pair')}<span className="sub">{t('board.ledger.pairSub')}</span></h2>
          <Mini
            rowKey={(r) => r.rule}
            rows={pair}
            cols={[
              [t('board.ledger.rule'), (r) => <b>{r.rule}</b>, true],
              [t('board.ledger.at'), (r) => (r.late ? t('board.ledger.atLate') : t('board.ledger.atEarly')), true],
              [t('board.ledger.settledPending'), (r) => `${r.bets} / ${r.pending}`],
              [t('board.ledger.record'), (r) => (r.bets ? `${r.wins}-${r.bets - r.wins}` : '—')],
              [t('board.ledger.pl'), (r) => (r.bets ? t('board.unitsVal', { v: signed(r.units) }) : '—')],
              ['ROI', (r) => (r.bets ? roi(r.roi) : '—')],
              [t('board.ledger.clv'), (r) => (r.clv ? t('board.ledger.clvVal', { v: signed(r.clv.mean * 100, 2), n: r.clv.n }) : '—')],
            ]}
          />
          <p className="note">
            {pair.every((r) => r.bets < MIN_LEDGER)
              ? t('board.ledger.pairSmall', { n: MIN_LEDGER })
              : t('board.ledger.pairBig')}
            {' '}{t('board.ledger.pairNote')}
            {late && late.bets + late.pending === 0 && t('board.ledger.lateNone')}
          </p>
        </div>
      )}

      <div className="card">
        <h2>{t('board.open.title')}<span className="sub">{t('board.open.sub')}</span></h2>
        {main && lg.open.length ? (
          <Mini
            rowKey={(r) => `${r.game_id}|${r.rule}`}
            rows={lg.open}
            cols={[
              [t('board.col.date'), (r) => fmt.date(r.game_date), true],
              [t('board.ledger.rule'), (r) => (r.rule.endsWith('-late') ? t('board.open.late') : t('board.open.early')), true],
              [t('board.open.priceAt'), (r) => (r.odds_fetched_at ? fmt.timeZoned(r.odds_fetched_at) : '—')],
              [t('board.col.matchup'), (r) => `${team(r.away_id)} @ ${team(r.home_id)}`, true],
              [t('board.open.side'), (r) => <b>{team(r.side === 'home' ? r.home_id : r.away_id)}</b>, true],
              [t('board.open.odds'), (r) => (r.bet_ml > 0 ? `+${r.bet_ml}` : r.bet_ml)],
              [t('board.open.probs'), (r) => {
                const s = r.side === 'home' ? 1 : -1;
                return `${pct(r.side === 'home' ? r.model_p_home : 1 - r.model_p_home, 0)} / ${pct(r.side === 'home' ? r.book_p_home : 1 - r.book_p_home, 0)}`
                  + ` (${signed(s * r.edge * 100, 1)})`;
              }],
            ]}
          />
        ) : <div className="empty">{t('board.open.none')}</div>}
      </div>

      {bt && (
        <div className="card">
          <h2>{t('board.books.title')}<span className="sub">{t('board.books.sub', { season: bt.rules.tuningSeason })}</span></h2>
          {/* 5 个按钮在手机上比内容区宽：放进可横向滚动的容器，页面本身不横滚 */}
          <div style={{ marginBottom: 10, maxWidth: '100%', overflowX: 'auto' }}>
            <Segmented value={season} onChange={setSeason}
              options={[{ value: 'all', label: t('board.books.all') }, ...seasons.map((s) => ({ value: s, label: s }))]} />
          </div>
          <Mini
            rowKey={(r) => `${r.book}|${r.season}|${r.threshold}`}
            rows={tableRows}
            cols={[
              [t('board.books.book'), (r) => (r.threshold === tableRows.find((x) => x.book === r.book)?.threshold ? <b>{name(r.book)}</b> : ''), true],
              [t('board.books.season'), (r) => (r.season === 'all' ? t('board.books.nSeasons', { count: r.seasons.length }) : r.season), true],
              [t('board.books.threshold'), (r) => thr(r.threshold)],
              [t('board.books.bets'), (r) => r.bets],
              [t('board.books.winRate'), (r) => pct(r.winRate)],
              [t('board.books.breakEven'), (r) => pct(r.breakEven)],
              ['ROI', (r) => <b className={r.roi > 0 ? 'pos' : 'neg'}>{roi(r.roi)}</b>],
              [t('board.ci95'), (r) => ciRoi(r.ci)],
              [t('board.books.dd'), (r) => num(r.maxDrawdown)],
            ]}
          />
          <p className="note">
            {t('board.books.note', { best: name('best') })}
          </p>
        </div>
      )}

      {bt && (
        <div className="grid cols-2">
          <div className="card">
            <h2>{t('board.clv.title')}<span className="sub">{t('board.clv.sub')}</span></h2>
            {bt.clv.length ? (
              <Mini
                rowKey={(r) => `${r.book}|${r.season}`}
                rows={bt.clv}
                cols={[
                  [t('board.books.book'), (r) => name(r.book), true],
                  [t('board.books.season'), (r) => r.season, true],
                  [t('board.books.bets'), (r) => r.bets],
                  [t('board.clv.mean'), (r) => t('board.clv.pp', { v: signed(r.clv.mean * 100, 2) })],
                  [t('board.ci95'), (r) => `${signed(r.clv.lo * 100, 2)} ~ ${signed(r.clv.hi * 100, 2)}`],
                  [t('board.clv.beat'), (r) => pct(r.clv.beatClose, 0)],
                  ['ROI', (r) => roi(r.roi)],
                ]}
              />
            ) : <div className="empty">{t('board.clv.none')}</div>}
            <p className="note">{t('board.clv.note')}</p>
          </div>
          <div className="card">
            <h2>{t('board.acc.title')}<span className="sub">{t('board.acc.sub')}</span></h2>
            <Mini
              rowKey={(r) => `${r.book}|${r.season}`}
              rows={bt.accuracy}
              cols={[
                [t('board.books.book'), (r) => name(r.book), true],
                [t('board.books.season'), (r) => r.season, true],
                [t('board.stats.games'), (r) => r.n],
                [t('board.acc.logLoss'), (r) => `${num(r.model.logloss, 3)} / ${num(r.market.logloss, 3)}`],
                [t('board.acc.brier'), (r) => `${num(r.model.brier, 3)} / ${num(r.market.brier, 3)}`],
              ]}
            />
          </div>
        </div>
      )}

      {bt && (
        <div className="card">
          <h2>{t('board.src.title')}<span className="sub">{t('board.src.sub', { date: fmt.date(bt.builtAt.slice(0, 10)) })}</span></h2>
          <Mini
            rowKey={(r) => r[0]}
            rows={Object.entries(bt.coverage)}
            cols={[
              [t('board.books.season'), (r) => r[0], true],
              [t('board.src.priced'), (r) => `${r[1].priced} / ${r[1].games}`],
              [t('board.src.books', { n: bt.rules.minGames }), (r) => Object.entries(r[1].books).filter(([, n]) => n >= bt.rules.minGames).map(([k]) => name(k)).join(t('board.listSep')) || '—', true],
              [t('board.src.at'), (r) => Object.entries(r[1].at).map(([k, n]) => `${k === 'close' ? t('board.src.close') : t('board.src.current')} ${n}`).join(' · '), true],
            ]}
          />
          <p className="note">
            {t('board.src.note')}
          </p>
        </div>
      )}
    </>
  );
}

export default function Board() {
  const { meta, teamById, out, params } = useApp();
  const { t } = useI18n();
  const [data, setData] = useState({ loading: true });
  const [tab, setTab] = useState('stats');
  const [more, setMore] = useState(false);

  useEffect(() => {
    let alive = true;
    setData((d) => ({ ...d, loading: true }));
    api.predictionBoard(withOut(params, out))
      .then((d) => alive && setData({ loading: false, ...d }))
      .catch((error) => alive && setData({ loading: false, error }));
    return () => { alive = false; };
  }, [params, out]);

  if (data.error) return <ErrorBox error={data.error} />;
  if (!data.summaryMsg) return <Loading />;
  const d = data;
  const { overall: o } = d;

  return (
    <>
      <div className="page-head">
        <h1>{t('board.title', { season: meta.targetSeason })}</h1>
        <p>{t('board.intro')}</p>
      </div>

      <div className="card">
        <h2>{t('board.summary')}<span className="sub">{t('board.summarySub')}</span></h2>
        {d.summaryMsg.map((m, i) => <p key={m.code + i} style={{ margin: '0 0 6px', lineHeight: 1.75 }}>{renderMsg(m, t)}</p>)}
        <p className="note">
          {t('board.summaryNote')}
        </p>
      </div>

      <div className="grid cols-5" style={{ margin: '14px 0' }}>
        <StatTile label={t('board.tile.record')} value={o.n ? `${o.hits}-${o.n - o.hits}` : '—'} hint={t('board.tile.recordHint', { n: o.n })} />
        <StatTile label={t('board.tile.acc')} value={o.n ? pct(o.acc) : '—'} hint={t('board.tile.accHint', { ci: ci(o.ci), n: o.n })} />
        <StatTile label={t('board.tile.brier')} value={o.n ? `${num(o.brier, 3)} / ${num(o.logLoss, 3)}` : '—'} hint={t('board.tile.brierHint')} />
        <StatTile label={t('board.tile.marginMae')} value={num(d.errors.marginMae)} unit={t('board.ptsUnit')} hint={`n = ${d.errors.n}`} />
        <StatTile
          label={t('board.tile.highConf')}
          value={d.highConf.n ? `${d.highConf.hits} / ${d.highConf.n}` : '—'}
          hint={t('board.tile.highConfHint')}
        />
      </div>

      <div style={{ marginBottom: 14 }}>
        <Segmented value={tab} onChange={setTab} options={tabs(t)} />
      </div>
      {data.loading && <Loading text={t('board.updating')} />}

      {tab === 'stats' && <Stats d={d} teamById={teamById} />}

      {tab === 'done' && (
        <div className="card">
          <h2>
            {t('board.done.title')}
            <span className="sub">
              {t('board.done.sub', { n: o.n })}
              {!d.market.shown && t('board.done.fewMarket', { n: d.market.n })}
            </span>
          </h2>
          <GamesTable games={d.completed} teamById={teamById} showMarket={d.market.shown} />
        </div>
      )}

      {tab === 'next' && (
        <>
          <div className="grid cols-5" style={{ marginBottom: 14 }}>
            <StatTile label={t('board.next.left')} value={d.upcomingDist.n} unit={t('common.unit.games', { count: d.upcomingDist.n })} />
            <StatTile label={t('board.next.tossups')} value={d.upcomingDist.tossups} unit={t('common.unit.games', { count: d.upcomingDist.tossups })} />
            {d.upcomingDist.buckets.slice(1).map((b) => (
              <StatTile key={b.label} label={t('board.next.conf', { label: b.label })} value={b.n} unit={t('common.unit.games', { count: b.n })} />
            ))}
          </div>
          <div className="card">
            <h2>
              {t('board.next.title')}
              <span className="sub">{t('board.next.sub')}{more ? t('board.next.days30') : t('board.next.days7')}</span>
            </h2>
            <GamesTable games={more ? d.upcoming : d.upcoming.slice(0, d.upcomingWeek)} teamById={teamById} upcoming />
            {!more && d.upcoming.length > d.upcomingWeek && (
              <button className="btn" style={{ marginTop: 10 }} onClick={() => setMore(true)}>
                {t('board.next.more', { n: d.upcoming.length })}
              </button>
            )}
          </div>
        </>
      )}

      {tab === 'bet' && <PaperBetting teamById={teamById} />}
    </>
  );
}
