import React, { useEffect, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api, withOut } from '../lib/api.js';
import {
  TeamCell, Loading, ErrorBox, ProbBar, StatTile, Segmented, DataTable,
} from '../components/common.jsx';
import { fmtDate, fmtDateShort, probColor, pct, num, signed, snapshotAge } from '../lib/format.js';

const TABS = [
  { value: 'stats', label: '统计' },
  { value: 'done', label: '已结束比赛' },
  { value: 'next', label: '接下来' },
  { value: 'bet', label: '投注参考' },
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

function Betting({ d, teamById }) {
  const b = d.betting;
  const withOdds = d.upcoming.filter((g) => g.market?.homeProb != null);
  const age = snapshotAge(d.oddsFetchedAt);
  return (
    <>
      <div className="warn-box">
        {b.summary.map((s) => <p key={s} style={{ margin: '2px 0' }}>{s}</p>)}
      </div>
      <div className="card">
        <h2>概率准不准：模型 vs 收盘盘口<span className="sub">同一批比赛；市场胜率已按比例去掉抽水；越低越好</span></h2>
        <Mini
          rowKey={(r) => r.season}
          rows={[{ season: '合计', n: b.n, model: b.model, market: b.market }, ...b.bySeason]}
          cols={[
            ['赛季', (r) => r.season, true],
            ['场数', (r) => r.n],
            ['模型 对数损失', (r) => num(r.model.logloss, 3)],
            ['盘口 对数损失', (r) => num(r.market.logloss, 3)],
            ['模型 Brier', (r) => num(r.model.brier, 3)],
            ['盘口 Brier', (r) => num(r.market.brier, 3)],
            ['模型 / 盘口 猜对', (r) => `${pct(r.model.accuracy)} / ${pct(r.market.accuracy)}`],
          ]}
        />
        <p className="note">
          单场对数损失差（模型 − 盘口）{num(b.logLossDiff?.mean, 4)}，按场 bootstrap 95% 区间 {num(b.logLossDiff?.lo, 4)} ~ {num(b.logLossDiff?.hi, 4)}
          （整体大于 0 = 模型更差）。用的是生产参数，不随侧栏开关变化。
        </p>
      </div>
      <div className="card">
        <h2>照分歧平注的回测<span className="sub">模型胜率比去抽水市场胜率高出门槛就押那一边 1 注，按收盘钱线（含抽水）结算</span></h2>
        <Mini
          rowKey={(r) => r.threshold}
          rows={b.strategies}
          cols={[
            ['门槛', (r) => `> ${pct(r.threshold, 0)}`, true],
            ['注数', (r) => r.bets],
            ['胜率', (r) => pct(r.winRate)],
            ['打平所需', (r) => pct(r.breakEven)],
            ['回报率', (r) => <b className={r.roi > 0 ? 'pos' : 'neg'}>{roi(r.roi)}</b>],
            ['95% 区间', (r) => `${roi(r.ci.lo)} ~ ${roi(r.ci.hi)}`],
            ...b.seasons.map((s) => [s, (r) => roi(r.bySeason.find((x) => x.season === s)?.roi)]),
          ]}
        />
        <p className="note">
          胜率远低于 50% 是因为分歧大多落在冷门一边（模型比市场更看好弱队），所以要和「打平所需」比，不能和 50% 比。
          收盘钱线平均抽水 {pct(b.overround)}；标准 -110 盘口打平要赢 {pct(b.breakEven)}。
        </p>
      </div>
      <div className="card">
        <h2>本赛季<span className="sub">{age ? `盘口快照${age.text}` : '没有盘口快照'}</span></h2>
        <p className="note">
          已结束的比赛里有盘口记录的 <b>{d.market.n}</b> 场——样本不足，无法评估模型本季相对市场的表现。
          未开打且有盘口的 {withOdds.length} 场列在下面，只是对照，按上面的历史证据不构成投注优势。
        </p>
        {withOdds.length > 0 && (
          <Mini
            rowKey={(r) => r.gameId}
            rows={withOdds}
            cols={[
              ['日期', (r) => fmtDate(r.date), true],
              ['对阵', (r) => `${teamById.get(r.awayId)?.cn} @ ${teamById.get(r.homeId)?.cn}`, true],
              ['模型主队胜率', (r) => pct(r.prediction.homeWinProb, 0)],
              ['盘口主队胜率', (r) => pct(r.market.homeProb, 0)],
              ['差', (r) => `${signed((r.prediction.homeWinProb - r.market.homeProb) * 100, 0)} 个百分点`],
            ]}
          />
        )}
      </div>
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

      {tab === 'bet' && <Betting d={d} teamById={teamById} />}
    </>
  );
}
