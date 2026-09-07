import React, { useEffect, useMemo, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api, withOut } from '../lib/api.js';
import {
  TeamLogo, TeamCell, PlayerHeadshot, StatTile, DataTable, InjuryBadge,
  Loading, ErrorBox, Segmented, ProbBar, Th,
} from '../components/common.jsx';
import PlayerTable, { MODE_OPTIONS } from '../components/PlayerTable.jsx';
import {
  num, rate, signed, signClass, fmtDate, restLabel, probColor, MONTH_CN, monthOf,
} from '../lib/format.js';

export default function TeamDetail({ teamId }) {
  const { meta, teamById, out, toggleOut, params, setAccent } = useApp();
  const [data, setData] = useState({ loading: true });
  const [statMode, setStatMode] = useState('base');
  const [month, setMonth] = useState('all');

  // 整站配色切到这支球队
  const team = teamById.get(teamId);
  useEffect(() => {
    if (team) setAccent(team);
    return () => setAccent(null);
  }, [team, setAccent]);

  useEffect(() => {
    let alive = true;
    setData({ loading: true });
    api.team(teamId, withOut(params, out))
      .then((d) => alive && setData({ loading: false, ...d }))
      .catch((error) => alive && setData({ loading: false, error }));
    return () => { alive = false; };
  }, [teamId, params, out]);

  const outIds = out[teamId] ?? [];

  const months = useMemo(() => {
    if (!data.schedule) return [];
    return [...new Set(data.schedule.map((g) => monthOf(g.date)))].sort((a, b) => {
      // 10、11、12 月在前，次年 1-4 月在后
      const k = (m) => (m >= 9 ? m : m + 12);
      return k(a) - k(b);
    });
  }, [data.schedule]);

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const { roster, arrivals, departures, schedule, ranking } = data;
  const t = data.team;
  const games = month === 'all' ? schedule : schedule.filter((g) => monthOf(g.date) === Number(month));

  const regular = schedule.filter((g) => g.type === 'regular');
  const projWins = regular.reduce(
    (s, g) => s + (g.homeId === teamId ? g.prediction.homeWinProb : 1 - g.prediction.homeWinProb),
    0,
  );
  const homeGames = schedule.filter((g) => g.homeId === teamId).length;
  const b2b = schedule.filter(
    (g) => (g.homeId === teamId ? g.prediction.restHome : g.prediction.restAway) === 0,
  ).length;

  return (
    <>
      <div className="card team-head">
        <TeamLogo team={t} size={62} />
        <div>
          <h1>{t.cn}</h1>
          <div className="en">
            {t.full} · {t.conference === 'East' ? '东部' : '西部'} {t.division} · {meta.priorSeason} {t.wins}-{t.losses}（分区第 {t.confRank}）
          </div>
        </div>
        <div className="right">
          <b className={signClass(ranking.total)}>{signed(ranking.total, 2)}</b>
          <span>综合实力 · 联盟第 {ranking.rank}</span>
        </div>
        <button className="btn" style={{ marginLeft: 14 }} onClick={() => go('teams')}>← 球队列表</button>
      </div>

      <div className="grid cols-5" style={{ marginBottom: 14 }}>
        <StatTile abbr="ORtg" label="进攻效率" value={num(t.adv.offRtg)} hint="每百回合得分" />
        <StatTile abbr="DRtg" label="防守效率" value={num(t.adv.defRtg)} hint="每百回合失分" />
        <StatTile abbr="NetRtg" label="净效率" value={signed(t.adv.netRtg)} />
        <StatTile abbr="PACE" label="节奏" value={num(t.adv.pace)} hint="每 48 分钟回合数" />
        <StatTile
          label={`${meta.targetSeason} 预计胜场`}
          value={projWins.toFixed(1)}
          unit={` / ${regular.length}`}
        />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>球队数据 <span className="sub">{meta.priorSeason} 场均</span></h2>
          <div className="grid cols-3">
            <StatTile abbr="PTS" label="得分" value={num(t.base.pts)} />
            <StatTile abbr="REB" label="篮板" value={num(t.base.reb)} />
            <StatTile abbr="AST" label="助攻" value={num(t.base.ast)} />
            <StatTile abbr="FG%" label="投篮" value={rate(t.base.fgPct)} />
            <StatTile abbr="3P%" label="三分" value={rate(t.base.fg3Pct)} />
            <StatTile abbr="FT%" label="罚球" value={rate(t.base.ftPct)} />
            <StatTile abbr="TS%" label="真实命中" value={rate(t.adv.tsPct)} />
            <StatTile abbr="AST%" label="助攻率" value={rate(t.adv.astPct)} />
            <StatTile abbr="3PA%" label="三分占比" value={rate(t.scoring.pct3pt)} />
          </div>
        </div>

        <div className="card">
          <h2>四要素 <span className="sub">己方 vs 对手</span></h2>
          <FourFactors ff={t.fourFactors} />
          <div className="divider" />
          <h2>赛程特征</h2>
          <div className="grid cols-3">
            <StatTile label="主场场次" value={homeGames} />
            <StatTile abbr="B2B" label="背靠背" value={b2b} />
            <StatTile abbr="ΔROS" label="阵容更迭" value={signed(ranking.turnoverAdj, 2)} hint="夏窗转会带来的实力变化" />
          </div>
        </div>
      </div>

      <div className="card">
        <h2>
          阵容
          <span className="sub">{roster.length} 人 · 勾选表示缺阵，全站预测实时生效</span>
          <span style={{ marginLeft: 'auto' }}>
            <Segmented
              value={statMode}
              onChange={setStatMode}
              options={MODE_OPTIONS}
            />
          </span>
        </h2>
        {outIds.length > 0 && (
          <div className="notice">
            {outIds.length} 名球员标记为缺阵，球队实力修正 {signed(ranking.rosterAdj, 2)} 分/场
          </div>
        )}
        <PlayerTable
          rows={roster}
          mode={statMode}
          nameColumn={{
            key: 'name', label: '球员', align: 'left', width: 226,
            render: (p) => (
              <span className="player-row">
                <input
                  type="checkbox"
                  title="标记缺阵"
                  checked={outIds.includes(p.playerId)}
                  onChange={() => toggleOut(teamId, p.playerId)}
                  onClick={(e) => e.stopPropagation()}
                />
                <PlayerHeadshot player={p} size={28} />
                <span style={{ opacity: outIds.includes(p.playerId) ? 0.42 : 1 }}>
                  {p.name}
                  <InjuryBadge injury={p.injury} />
                  {p.noPriorData && <span className="chip" style={{ marginLeft: 6 }}>无上季数据</span>}
                </span>
              </span>
            ),
          }}
          extraColumns={[
            { key: 'number', label: '号', width: 36, render: (p) => <span className="dim">{p.number}</span> },
            { key: 'posCn', label: '位置', width: 72, align: 'left', render: (p) => <span className="dim">{p.posCn || '—'}</span> },
            { key: 'age', label: '年龄', width: 44, render: (p) => num(p.age, 0) },
          ]}
        />
      </div>

      <div className="card">
        <h2>
          阵容更迭
          <span className="sub">
            转入 {arrivals.length} 人 · 转出 {departures.length} 人 · 合计 {signed(ranking.turnoverAdj, 2)} 分/场
          </span>
        </h2>
        <div className="grid cols-2">
          <MoveList title="转入" tone="pos" rows={arrivals} teamById={teamById} from />
          <MoveList title="转出" tone="neg" rows={departures} teamById={teamById} />
        </div>
        <p className="note" style={{ marginTop: 10 }}>
          按上赛季整季总出场分钟排序。上赛季没有 NBA 出场记录的球员（新秀、海外新援）
          模型按替补级计算，不计入实力增减。
        </p>
      </div>

      <div className="card">
        <h2>
          {meta.targetSeason} 赛程与预测
          <span className="sub">{games.length} 场</span>
          <span style={{ marginLeft: 'auto' }}>
            <select value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="all">全部月份</option>
              {months.map((m) => <option key={m} value={m}>{MONTH_CN[m] ?? `${m}月`}</option>)}
            </select>
          </span>
        </h2>
        <TeamSchedule games={games} teamId={teamId} teamById={teamById} />
        <p className="note" style={{ marginTop: 10 }}>
          全季 {homeGames} 个主场、{b2b} 场背靠背。
          预计胜场按逐场胜率累加得到，已计入主客场、休息天数与当前缺阵名单。
        </p>
      </div>
    </>
  );
}

function FourFactors({ ff }) {
  const rows = [
    { i: 1, abbr: "eFG%", label: "有效命中率", own: ff.efgPct, opp: ff.oppEfgPct, better: 'high' },
    { i: 2, abbr: "TOV%", label: "失误率", own: ff.tovPct, opp: ff.oppTovPct, better: 'low' },
    { i: 3, abbr: "OREB%", label: "前场篮板率", own: ff.orebPct, opp: ff.oppOrebPct, better: 'high' },
    { i: 4, abbr: "FTr", label: "罚球造犯规率", own: ff.ftaRate, opp: ff.oppFtaRate, better: 'high' },
  ];
  return (
    <DataTable
      columns={[
        // 按四要素的公认权重顺序固定排列，而不是按中文名排序
        {
          key: "label", label: "要素", align: "left", width: 138, value: (r) => r.i,
          render: (r) => <span className="row-label"><b>{r.abbr}</b><i>{r.label}</i></span>,
        },
        { key: "own", label: <Th abbr="TM" cn="己方" />, title: "己方", width: 66, render: (r) => `${rate(r.own)}%` },
        { key: "opp", label: <Th abbr="OPP" cn="对手" />, title: "对手", width: 66, render: (r) => `${rate(r.opp)}%` },
        {
          key: 'diff', label: '优势', width: 66,
          value: (r) => (r.better === 'high' ? r.own - r.opp : r.opp - r.own),
          render: (r) => {
            const d = (r.better === 'high' ? r.own - r.opp : r.opp - r.own) * 100;
            return <span className={signClass(d)}>{signed(d, 1)}</span>;
          },
        },
      ]}
      rows={rows}
      initialSort={{ key: 'label', dir: 'asc' }}
      rowKey={(r) => r.label}
    />
  );
}

/** 转入/转出名单 */
function MoveList({ title, tone, rows, teamById, from }) {
  if (!rows.length) {
    return <div><b className={tone} style={{ fontSize: 12.5 }}>{title}</b><div className="empty">无</div></div>;
  }
  return (
    <div>
      <b className={tone} style={{ fontSize: 12.5 }}>{title}</b>
      <div className="scroll-y" style={{ maxHeight: 300, marginTop: 6 }}>
        <table className="data">
          <tbody>
            {rows.map((p) => {
              const other = teamById.get(from ? p.priorTeamId : p.teamId);
              return (
                <tr key={p.playerId}>
                  <td className="left" style={{ width: 176 }}>
                    <span className="player-cell">
                      <PlayerHeadshot player={p} size={26} />
                      <span>{p.name}</span>
                    </span>
                  </td>
                  <td className="left dim" style={{ width: 92, fontSize: 11 }}>
                    {p.noPriorData
                      ? <span className="chip">新秀/无数据</span>
                      : other
                        ? <span className="team-cell"><TeamLogo team={other} size={17} />{from ? '来自' : '去往'}</span>
                        : (from ? '自由球员' : '离开联盟')}
                  </td>
                  <td className="dim" style={{ width: 74, fontSize: 11 }}>
                    {p.gp ? `${p.gp}场 ${num(p.min)}分` : '—'}
                  </td>
                  <td style={{ width: 52 }} className="mono">
                    {p.outCostPts < -0.05
                      ? <span className={tone}>{num(Math.abs(p.outCostPts), 1)}</span>
                      : <span className="dim">≈0</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TeamSchedule({ games, teamId, teamById }) {
  return (
    <DataTable
      maxHeight={560}
      rows={games}
      rowKey={(g) => g.gameId}
      initialSort={{ key: 'date', dir: 'asc' }}
      onRowClick={(g) => go(`predict/${g.awayId}/${g.homeId}/${g.gameId}`)}
      columns={[
        {
          key: 'date', label: '日期', align: 'left', width: 110,
          render: (g) => <span className="dim">{fmtDate(g.date)}</span>,
        },
        {
          key: 'opp', label: '对手', align: 'left', width: 206,
          value: (g) => (g.homeId === teamId ? g.awayAbbr : g.homeAbbr),
          render: (g) => {
            const home = g.homeId === teamId;
            const opp = teamById.get(home ? g.awayId : g.homeId);
            return (
              <span className="team-cell">
                <span className="ab" style={{ width: 18 }}>{home ? 'vs' : '@'}</span>
                <TeamCell team={opp} size={20} showAbbr={false} />
              </span>
            );
          },
        },
        {
          key: 'rest', label: '休息', width: 62,
          value: (g) => (g.homeId === teamId ? g.prediction.restHome : g.prediction.restAway),
          render: (g) => {
            const r = g.homeId === teamId ? g.prediction.restHome : g.prediction.restAway;
            return <span className={r === 0 ? 'neg' : 'dim'}>{restLabel(r)}</span>;
          },
        },
        {
          key: 'win', label: '预测胜率', width: 116,
          value: (g) => (g.homeId === teamId ? g.prediction.homeWinProb : 1 - g.prediction.homeWinProb),
          render: (g) => {
            const p = g.homeId === teamId ? g.prediction.homeWinProb : 1 - g.prediction.homeWinProb;
            return (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <ProbBar p={p} width={50} />
                <b className="mono" style={{ color: probColor(p) }}>{(p * 100).toFixed(0)}%</b>
              </span>
            );
          },
        },
        {
          key: 'score', label: '预测比分', width: 90,
          value: (g) => (g.homeId === teamId ? g.prediction.margin : -g.prediction.margin),
          render: (g) => {
            const own = g.homeId === teamId ? g.prediction.homeScore : g.prediction.awayScore;
            const opp = g.homeId === teamId ? g.prediction.awayScore : g.prediction.homeScore;
            return <span className="mono">{own.toFixed(0)} - {opp.toFixed(0)}</span>;
          },
        },
        {
          key: 'label', label: '备注', align: 'left', width: 152,
          render: (g) => (g.label
            ? <span className="chip blue">{g.label}</span>
            : <span className="dim">{g.national?.join('/') || ''}</span>),
        },
      ]}
    />
  );
}
