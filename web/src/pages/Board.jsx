import React, { useEffect, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api, withOut } from '../lib/api.js';
import {
  TeamCell, Loading, ErrorBox, ProbBar, StatTile, Segmented, DataTable,
} from '../components/common.jsx';
import { fmtDate, fmtDateShort, probColor, pct, num, signed, bjTimeOf } from '../lib/format.js';

const TABS = [
  { value: 'stats', label: '统计' },
  { value: 'done', label: '已结束比赛' },
  { value: 'next', label: '接下来' },
  { value: 'bet', label: '模拟投注' },
];

const ci = (c) => (c?.lo == null ? '—' : `${pct(c.lo, 0)} – ${pct(c.hi, 0)}`);
const roi = (v) => (v == null ? '—' : `${signed(v * 100)}%`);

/** 主队胜率：和赛程页同一个样子 */
const Prob = ({ p }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
    <ProbBar p={p} width={52} />
    <b className="mono" style={{ color: probColor(p) }}>{(p * 100).toFixed(0)}%</b>
  </span>
);

const Hit = ({ hit }) => <span className={`chip ${hit ? 'hit' : 'miss'}`}>{hit ? '✓ 命中' : '✗ 未中'}</span>;

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
  return (
    <div className="table-wrap" style={{ maxHeight: 700, overflowY: 'auto' }}>
      <table className="data">
        <thead>
          <tr>
            <th className="left" style={{ width: 112 }}>日期</th>
            <th className="left" style={{ width: 184 }}>客队</th>
            <th className="left" style={{ width: 184 }}>主队</th>
            <th style={{ width: 122 }}>主队胜率</th>
            <th style={{ width: 84 }}>预测比分</th>
            {!upcoming && <th style={{ width: 118 }} title="真实比分，以及赛前预测的胜方是否猜对">实际 / 命中</th>}
            {upcoming && <th className="left" style={{ width: 150 }}>看好</th>}
            {showMarket && <th style={{ width: 96 }} title="去抽水后的市场主队胜率（仅作参考）">盘口胜率</th>}
          </tr>
        </thead>
        <tbody>
          {games.map((g, i) => {
            const p = g.prediction.homeWinProb;
            return (
              <tr key={g.gameId} className="clickable" onClick={() => go(`predict/${g.awayId}/${g.homeId}/${g.gameId}`)}>
                <td className="left sched-date">{i === 0 || games[i - 1].date !== g.date ? fmtDate(g.date) : ''}</td>
                <td className="left"><TeamCell team={teamById.get(g.awayId)} size={20} showAbbr={false} /></td>
                <td className="left"><TeamCell team={teamById.get(g.homeId)} size={20} showAbbr={false} /></td>
                <td><Prob p={p} /></td>
                <td className={upcoming ? 'mono' : 'mono dim'}>
                  {g.prediction.awayScore.toFixed(0)} - {g.prediction.homeScore.toFixed(0)}
                </td>
                {!upcoming && <td className="mono"><b>{g.awayScore} - {g.homeScore}</b> <Hit hit={g.hit} /></td>}
                {upcoming && (
                  <td className="left">
                    {teamById.get(p >= 0.5 ? g.homeId : g.awayId)?.cn}{' '}
                    <span className="dim mono">{pct(Math.max(p, 1 - p), 0)}</span>
                  </td>
                )}
                {showMarket && <td className="mono">{g.market?.homeProb != null ? pct(g.market.homeProb, 0) : '—'}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
      {games.length === 0 && <div className="empty">没有比赛</div>}
    </div>
  );
}

function Stats({ d, teamById }) {
  const teamRows = d.byTeam.map((t) => ({ ...t, team: teamById.get(t.key) }));
  return (
    <>
      <div className="grid cols-2">
        <div className="card">
          <h2>基准线<span className="sub">同一批 {d.overall.n} 场比赛，看我们比最简单的猜法强多少</span></h2>
          <Mini
            rowKey={(r) => r.key}
            rows={d.baselines}
            cols={[
              ['方法', (r) => (r.key === 'model' ? <b>{r.label}</b> : r.label), true],
              ['猜对 / 场数', (r) => `${r.hits} / ${r.n}`],
              ['准确率', (r) => pct(r.acc)],
              ['95% 区间', (r) => ci(r.ci)],
            ]}
          />
        </div>
        <div className="card">
          <h2>误差<span className="sub">预测 − 实际，n = {d.errors.n}</span></h2>
          <Mini
            rows={[
              ['Brier', num(d.overall.brier, 3), '每场都报 50% = 0.250'],
              ['对数损失', num(d.overall.logLoss, 3), '每场都报 50% = 0.693'],
              ['分差 MAE', `${num(d.errors.marginMae)} 分`, `偏置 ${signed(d.errors.marginBias)}（正 = 高估主队）`],
              ['总分 MAE', `${num(d.errors.totalMae)} 分`, `偏置 ${signed(d.errors.totalBias)}（正 = 高估总分）`],
              ['单队得分 MAE', `${num(d.errors.scoreMae)} 分`, '主客两队各算一次'],
            ]}
            cols={[['指标', (r) => r[0], true], ['数值', (r) => r[1]], ['说明', (r) => <span className="dim">{r[2]}</span>, true]]}
          />
        </div>
      </div>

      <div className="card">
        <h2>校准<span className="sub">按赛前信心分档：说七成的比赛，真的赢了七成吗？每档样本都很小</span></h2>
        <Mini
          rowKey={(r) => r.label}
          rows={d.buckets}
          cols={[
            ['信心', (r) => r.label, true],
            ['场数', (r) => r.n],
            ['预测平均', (r) => pct(r.conf)],
            ['实际命中', (r) => (r.n ? <span style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}><ProbBar p={r.acc} width={52} />{r.hits} 场 · {pct(r.acc)}</span> : '—')],
          ]}
        />
      </div>

      <div className="grid cols-3" style={{ marginTop: 14 }}>
        {d.splits.map((s) => (
          <div className="card" key={s.title}>
            <h2>{s.title}</h2>
            <Mini
              rowKey={(r) => r.label}
              rows={s.rows}
              cols={[
                ['', (r) => r.label, true],
                ['猜对 / 场数', (r) => `${r.hits} / ${r.n}`],
                ['准确率', (r) => pct(r.acc, 0)],
              ]}
            />
          </div>
        ))}
      </div>

      <div className="card">
        <h2>看走眼的比赛<span className="sub">赛前信心 ≥65% 却猜错，共 {d.misses.length} 场</span></h2>
        <Mini
          rowKey={(r) => r.gameId}
          rows={d.misses}
          cols={[
            ['日期', (r) => fmtDate(r.date), true],
            ['对阵', (r) => `${teamById.get(r.awayId)?.cn} @ ${teamById.get(r.homeId)?.cn}`, true],
            ['我们看好', (r) => `${teamById.get(r.p >= 0.5 ? r.homeId : r.awayId)?.cn} ${pct(r.conf, 0)}`, true],
            ['实际', (r) => `${r.awayScore} - ${r.homeScore}`],
          ]}
        />
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>逐日<span className="sub">累计准确率随样本变化，早期的起伏大多是噪声</span></h2>
          <Mini
            rowKey={(r) => r.key}
            rows={d.byDate}
            cols={[
              ['日期', (r) => fmtDateShort(r.key), true],
              ['当日', (r) => `${r.hits} / ${r.n}`],
              ['累计', (r) => `${r.cumHits} / ${r.cumN}`],
              ['累计准确率', (r) => <span style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}><ProbBar p={r.cumAcc} width={52} />{pct(r.cumAcc)}</span>],
            ]}
          />
        </div>
        <div className="card">
          <h2>按球队<span className="sub">涉及该队的比赛猜对多少；每队只有三四场，点表头排序</span></h2>
          <DataTable
            rows={teamRows}
            rowKey={(r) => r.key}
            maxHeight={420}
            initialSort={{ key: 'acc', dir: 'desc' }}
            onRowClick={(r) => go(`team/${r.key}`)}
            columns={[
              { key: 'team', label: '球队', align: 'left', value: (r) => r.team?.cn ?? '', render: (r) => <TeamCell team={r.team} size={20} showAbbr={false} /> },
              { key: 'n', label: '场数' },
              { key: 'hits', label: '猜对' },
              { key: 'acc', label: '准确率', render: (r) => pct(r.acc, 0) },
            ]}
          />
        </div>
      </div>
    </>
  );
}

/** 累计盈亏曲线（单位：注）。横轴按下注顺序，纵轴自适应并画出 0 线 */
function Curve({ points, label }) {
  if (points.length < 2) return <div className="empty">还没有足够的已结算注单画曲线</div>;
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
        <span>{fmtDateShort(points[0].date)} → {fmtDateShort(points.at(-1).date)}</span>
        <span>最高 {signed(hi)} · 最低 {signed(lo)} · 最终 <b className={last >= 0 ? 'pos' : 'neg'}>{signed(last)} 注</b></span>
      </div>
    </>
  );
}

const thr = (t) => `≥ ${pct(t, 0)}`;
const ciRoi = (c) => (c?.lo == null ? '—' : `${roi(c.lo)} ~ ${roi(c.hi)}`);
const MIN_LEDGER = 100;

function PaperBetting({ teamById }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [season, setSeason] = useState('all');
  useEffect(() => { api.paper().then(setD).catch(setErr); }, []);
  if (err) return <ErrorBox error={err} />;
  if (!d) return <Loading />;
  const { backtest: bt, ledger: lg } = d;
  const name = (k) => bt?.bookNames?.[k] ?? k;
  const team = (id) => teamById.get(id)?.cn ?? id;
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
        <p style={{ margin: '2px 0' }}><b>{bt ? bt.headline.verdict : '历史回测还没生成（node scripts/paper-backtest.mjs）。'}</b></p>
        <p style={{ margin: '2px 0' }}>
          这是模拟，不是建议。规则事先固定：模型胜率比 DraftKings 去水胜率高 3 个百分点以上就押那一边 1 注，按真实（含水）赔率结算；
          0% / 6% 门槛、挑最优价、各家逐一回测都一起列出，不挑最好的报。
        </p>
      </div>

      {bt && (
        <div className="grid cols-5" style={{ margin: '14px 0' }}>
          <StatTile label="样本外注数（DK, ≥3%）" value={bt.headline.bets} hint={bt.headline.seasons.join(' / ') || '—'} />
          <StatTile label="ROI" value={roi(bt.headline.roi)} hint={`95% 区间 ${ciRoi(bt.headline.ci)}`} />
          <StatTile label="胜率 / 保本胜率" value={`${pct(bt.headline.winRate)} / ${pct(bt.headline.breakEven)}`} hint="胜率要高过保本线才不亏" />
          <StatTile label="累计盈亏" value={signed(bt.headline.units)} unit=" 注" hint="每注 1 单位" />
          <StatTile label="最大回撤" value={num(bt.headline.maxDrawdown)} unit=" 注" hint="从累计高点回落的最大幅度" />
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <h2>累计盈亏 · 历史回测<span className="sub">DraftKings、edge ≥ 3%、样本外赛季，按下注顺序</span></h2>
          {bt ? <Curve points={bt.headline.curve} label="历史回测累计盈亏" /> : <div className="empty">没有历史回测</div>}
        </div>
        <div className="card">
          <h2>累计盈亏 · 本季账本<span className="sub">开赛前记录、赛后结算，记录后不可改</span></h2>
          {main ? <Curve points={main.curve} label="本季账本累计盈亏" /> : <div className="empty">{lg.reason}</div>}
          {main && (
            <p className="note">
              已结算 <b>{main.bets}</b> 注、待结算 {main.pending} 注，自 {lg.firstDate ?? '—'} 起共记录 {lg.captured} 场。
              {main.bets < MIN_LEDGER
                ? ` 样本只有 ${main.bets} 注，太小，不下结论。`
                : ` ROI ${roi(main.roi)}（95% 区间 ${ciRoi(main.ci)}）。`}
            </p>
          )}
        </div>
      </div>

      {main && (
        <div className="card">
          <h2>本季账本 · 早记 vs 临近开赛<span className="sub">同一规则（edge ≥ 3%、DK、平注 1 单位），只是记录时点不同</span></h2>
          <Mini
            rowKey={(r) => r.rule}
            rows={pair}
            cols={[
              ['规则', (r) => <b>{r.rule}</b>, true],
              ['记录时点', (r) => (r.late ? '北京 06:30（开赛前约 0.5–4 小时）' : '北京 22:00（开赛前 9–12 小时）'), true],
              ['已结算 / 待结算', (r) => `${r.bets} / ${r.pending}`],
              ['战绩', (r) => (r.bets ? `${r.wins}-${r.bets - r.wins}` : '—')],
              ['盈亏', (r) => (r.bets ? `${signed(r.units)} 注` : '—')],
              ['ROI', (r) => (r.bets ? roi(r.roi) : '—')],
              ['平均 CLV（对收盘）', (r) => (r.clv ? `${signed(r.clv.mean * 100, 2)} 个百分点（${r.clv.n} 注）` : '—')],
            ]}
          />
          <p className="note">
            {pair.every((r) => r.bets < MIN_LEDGER)
              ? `两边各不足 ${MIN_LEDGER} 注，差别是噪声，不下结论。`
              : '样本已过 100 注，但早晚两条下的大多是同几场，差别仍要看区间。'}
            {' '}临近开赛的价更接近收盘，所以它的 CLV 天然接近 0；早记的 CLV 为正也不等于赚钱（历史回测里 CLV 为正、ROI 仍为负）。
            晚规则只在 06:30 那次刷新新抓到盘口时记录，刷新失败那天不补；已开赛的比赛不记。
            {late && late.bets + late.pending === 0 && ' 晚规则还没有记录：要等服务器 06:30 那次刷新带上 --late。'}
          </p>
        </div>
      )}

      <div className="card">
        <h2>今晚模拟下注<span className="sub">模拟，不是建议 · 账本里已记录、尚未结算的 edge ≥ 3% 选择（早记、临近开赛各一条规则）</span></h2>
        {main && lg.open.length ? (
          <Mini
            rowKey={(r) => `${r.game_id}|${r.rule}`}
            rows={lg.open}
            cols={[
              ['日期', (r) => fmtDate(r.game_date), true],
              ['规则', (r) => (r.rule.endsWith('-late') ? '临近开赛' : '早记'), true],
              ['价格时间', (r) => (r.odds_fetched_at ? `北京 ${bjTimeOf(r.odds_fetched_at)}` : '—')],
              ['对阵', (r) => `${team(r.away_id)} @ ${team(r.home_id)}`, true],
              ['模拟押', (r) => <b>{team(r.side === 'home' ? r.home_id : r.away_id)}</b>, true],
              ['DK 赔率', (r) => (r.bet_ml > 0 ? `+${r.bet_ml}` : r.bet_ml)],
              ['模型 / DK 去水', (r) => {
                const s = r.side === 'home' ? 1 : -1;
                return `${pct(r.side === 'home' ? r.model_p_home : 1 - r.model_p_home, 0)} / ${pct(r.side === 'home' ? r.book_p_home : 1 - r.book_p_home, 0)}`
                  + ` (${signed(s * r.edge * 100, 1)})`;
              }],
            ]}
          />
        ) : <div className="empty">今天账本里没有达到门槛的选择（或还没到记录时间：早记在开赛前 14 小时内，临近开赛在北京 06:30）</div>}
      </div>

      {bt && (
        <div className="card">
          <h2>博彩商 × 门槛<span className="sub">ROI 区间为按场 bootstrap 95%；门槛只允许在 {bt.rules.tuningSeason} 上看，之后各季只报告</span></h2>
          {/* 5 个按钮在手机上比内容区宽：放进可横向滚动的容器，页面本身不横滚 */}
          <div style={{ marginBottom: 10, maxWidth: '100%', overflowX: 'auto' }}>
            <Segmented value={season} onChange={setSeason}
              options={[{ value: 'all', label: '合计' }, ...seasons.map((s) => ({ value: s, label: s }))]} />
          </div>
          <Mini
            rowKey={(r) => `${r.book}|${r.season}|${r.threshold}`}
            rows={tableRows}
            cols={[
              ['博彩商', (r) => (r.threshold === tableRows.find((x) => x.book === r.book)?.threshold ? <b>{name(r.book)}</b> : ''), true],
              ['赛季', (r) => (r.season === 'all' ? `${r.seasons.length} 季` : r.season), true],
              ['门槛', (r) => thr(r.threshold)],
              ['注数', (r) => r.bets],
              ['胜率', (r) => pct(r.winRate)],
              ['保本', (r) => pct(r.breakEven)],
              ['ROI', (r) => <b className={r.roi > 0 ? 'pos' : 'neg'}>{roi(r.roi)}</b>],
              ['95% 区间', (r) => ciRoi(r.ci)],
              ['回撤', (r) => num(r.maxDrawdown)],
            ]}
          />
          <p className="note">
            「挑最优价」= 用各家去水胜率的中位数判断，每一边取美国持牌各家里最高的赔率结算（Betfair 等非美国站点不参与挑价）。
            FanDuel 在 ESPN 的任何赛季都没有数据；2024-25 只有 ESPN BET，2025-26 起只有 DraftKings。
          </p>
        </div>
      )}

      {bt && (
        <div className="grid cols-2">
          <div className="card">
            <h2>收盘线价值（CLV）<span className="sub">按开盘价下注（同样 ≥3%），收盘价往我们押的一边走多少</span></h2>
            {bt.clv.length ? (
              <Mini
                rowKey={(r) => `${r.book}|${r.season}`}
                rows={bt.clv}
                cols={[
                  ['博彩商', (r) => name(r.book), true],
                  ['赛季', (r) => r.season, true],
                  ['注数', (r) => r.bets],
                  ['平均 CLV', (r) => `${signed(r.clv.mean * 100, 2)} 个百分点`],
                  ['95% 区间', (r) => `${signed(r.clv.lo * 100, 2)} ~ ${signed(r.clv.hi * 100, 2)}`],
                  ['好于收盘', (r) => pct(r.clv.beatClose, 0)],
                  ['ROI', (r) => roi(r.roi)],
                ]}
              />
            ) : <div className="empty">没有同时带开盘与收盘价的赛季</div>}
            <p className="note">长期赢盘口的下注者通常 CLV 为正，但正 CLV 不等于赚钱：收盘往我们这边挪得不够多，照样付不起抽水——要和同一行的 ROI 一起看。区间含 0 就是没证据。</p>
          </div>
          <div className="card">
            <h2>为什么赚/亏：概率准不准<span className="sub">模型 vs 该家去水概率，同一批比赛，越低越好</span></h2>
            <Mini
              rowKey={(r) => `${r.book}|${r.season}`}
              rows={bt.accuracy}
              cols={[
                ['博彩商', (r) => name(r.book), true],
                ['赛季', (r) => r.season, true],
                ['场数', (r) => r.n],
                ['对数损失 模型 / 盘口', (r) => `${num(r.model.logloss, 3)} / ${num(r.market.logloss, 3)}`],
                ['Brier 模型 / 盘口', (r) => `${num(r.model.brier, 3)} / ${num(r.market.brier, 3)}`],
              ]}
            />
          </div>
        </div>
      )}

      {bt && (
        <div className="card">
          <h2>数据来源<span className="sub">ESPN 公开接口，生成于 {fmtDate(bt.builtAt.slice(0, 10))}</span></h2>
          <Mini
            rowKey={(r) => r[0]}
            rows={Object.entries(bt.coverage)}
            cols={[
              ['赛季', (r) => r[0], true],
              ['有价 / 全部', (r) => `${r[1].priced} / ${r[1].games}`],
              ['博彩商（≥200 场）', (r) => Object.entries(r[1].books).filter(([, n]) => n >= bt.rules.minGames).map(([k]) => name(k)).join('、') || '—', true],
              ['时点', (r) => Object.entries(r[1].at).map(([k, n]) => `${k === 'close' ? '收盘' : '当前'} ${n}`).join(' · '), true],
            ]}
          />
          <p className="note">
            模型概率是生产参数的逐场赛前 Elo 重放（2021-22 只作预热）。每家每场取最接近收盘的价：有 close 用 close，否则用 current（2021-22、2022-23 多数只有 current），
            从不用开盘价冒充收盘。已剔除 in-game Live Odds、聚合源与离当场中位让分超过 3 分的离谱线；Caesars 各州 id 合并为一家。
          </p>
        </div>
      )}
    </>
  );
}

export default function Board() {
  const { meta, teamById, out, params } = useApp();
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
  if (!data.summary) return <Loading />;
  const d = data;
  const { overall: o } = d;

  return (
    <>
      <div className="page-head">
        <h1>{meta.targetSeason} 预测总表</h1>
        <p>我们的模型对本季常规赛每一场的赛前预测与真实结果。季前赛不计。</p>
      </div>

      <div className="card">
        <h2>总结<span className="sub">按当前数据自动生成</span></h2>
        {d.summary.map((s) => <p key={s} style={{ margin: '0 0 6px', lineHeight: 1.75 }}>{s}</p>)}
        <p className="note">
          已结束比赛的胜率与赛程页同一口径：用开打前的 Elo 重算，不套用当前的缺阵勾选。
          只有 Elo 换回了赛前值，名单与参数是现在的，所以这是「用赛前评级重算」，不是当时存档的预测。
        </p>
      </div>

      <div className="grid cols-5" style={{ margin: '14px 0' }}>
        <StatTile label="战绩（猜对-猜错）" value={o.n ? `${o.hits}-${o.n - o.hits}` : '—'} hint={`已结束 ${o.n} 场`} />
        <StatTile label="赛前预测命中" value={o.n ? pct(o.acc) : '—'} hint={`95% 区间 ${ci(o.ci)}，n = ${o.n}`} />
        <StatTile label="Brier / 对数损失" value={o.n ? `${num(o.brier, 3)} / ${num(o.logLoss, 3)}` : '—'} hint="越低越好；每场都报 50% 是 0.250 / 0.693" />
        <StatTile label="分差平均误差" value={num(d.errors.marginMae)} unit=" 分" hint={`n = ${d.errors.n}`} />
        <StatTile
          label="高信心 ≥70% 命中"
          value={d.highConf.n ? `${d.highConf.hits} / ${d.highConf.n}` : '—'}
          hint="赛前信心至少七成的比赛"
        />
      </div>

      <div style={{ marginBottom: 14 }}>
        <Segmented value={tab} onChange={setTab} options={TABS} />
      </div>
      {data.loading && <Loading text="正在更新…" />}

      {tab === 'stats' && <Stats d={d} teamById={teamById} />}

      {tab === 'done' && (
        <div className="card">
          <h2>
            已结束比赛
            <span className="sub">
              {o.n} 场，最新的在上；胜率为主队获胜概率
              {!d.market.shown && ` · 有盘口的只有 ${d.market.n} 场，不单列盘口`}
            </span>
          </h2>
          <GamesTable games={d.completed} teamById={teamById} showMarket={d.market.shown} />
        </div>
      )}

      {tab === 'next' && (
        <>
          <div className="grid cols-5" style={{ marginBottom: 14 }}>
            <StatTile label="剩余常规赛" value={d.upcomingDist.n} unit=" 场" />
            <StatTile label="五五开（<55%）" value={d.upcomingDist.tossups} unit=" 场" />
            {d.upcomingDist.buckets.slice(1).map((b) => (
              <StatTile key={b.label} label={`信心 ${b.label}`} value={b.n} unit=" 场" />
            ))}
          </div>
          <div className="card">
            <h2>
              接下来的比赛
              <span className="sub">按当前评级（含侧栏的缺阵勾选）预测；{more ? '未来 30 天' : '未来 7 天'}</span>
            </h2>
            <GamesTable games={more ? d.upcoming : d.upcoming.slice(0, d.upcomingWeek)} teamById={teamById} upcoming />
            {!more && d.upcoming.length > d.upcomingWeek && (
              <button className="btn" style={{ marginTop: 10 }} onClick={() => setMore(true)}>
                显示更多（未来 30 天共 {d.upcoming.length} 场）
              </button>
            )}
          </div>
        </>
      )}

      {tab === 'bet' && <PaperBetting teamById={teamById} />}
    </>
  );
}
