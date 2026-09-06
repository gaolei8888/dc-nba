import React, { useEffect, useMemo, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api, withOut } from '../lib/api.js';
import {
  TeamBadge, TeamCell, StatTile, DataTable, Loading, ErrorBox, Segmented, ProbBar,
} from '../components/common.jsx';
import PlayerTable from '../components/PlayerTable.jsx';
import {
  num, rate, signed, signClass, fmtDate, restLabel, probColor, MONTH_CN, monthOf,
} from '../lib/format.js';

export default function TeamDetail({ teamId }) {
  const { meta, teamById, out, toggleOut, params } = useApp();
  const [data, setData] = useState({ loading: true });
  const [statMode, setStatMode] = useState('base');
  const [month, setMonth] = useState('all');

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

  const { team, roster, arrivals, departures, schedule, ranking } = data;
  const games = month === 'all' ? schedule : schedule.filter((g) => monthOf(g.date) === Number(month));

  const projWins = schedule
    .filter((g) => g.type === 'regular')
    .reduce((s, g) => s + (g.homeId === teamId ? g.prediction.homeWinProb : 1 - g.prediction.homeWinProb), 0);
  const homeGames = schedule.filter((g) => g.homeId === teamId).length;
  const b2b = schedule.filter((g) => (g.homeId === teamId ? g.prediction.restHome : g.prediction.restAway) === 0).length;

  return (
    <>
      <div className="page-head" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <TeamBadge team={team} size={52} />
        <div style={{ flex: 1 }}>
          <h1 style={{ marginBottom: 2 }}>{team.cn}</h1>
          <p>
            {team.full} · {team.conference === 'East' ? '东部' : '西部'} {team.division} 赛区 ·
            {' '}{meta.priorSeason} 战绩 {team.wins}-{team.losses}（分区第 {team.confRank}）
          </p>
        </div>
        <button className="btn" onClick={() => go('teams')}>← 返回球队列表</button>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <StatTile label="综合实力（每场净胜分）" value={signed(ranking.total, 2)} hint="含当前缺阵修正" />
        <StatTile label="实力排名" value={`第 ${ranking.rank}`} unit=" / 30" />
        <StatTile label={`${meta.targetSeason} 预计胜场`} value={projWins.toFixed(1)} unit={` / ${schedule.filter((g) => g.type === 'regular').length}`} />
        <StatTile
          label="阵容更迭修正"
          value={signed(ranking.turnoverAdj, 2)}
          hint="夏窗转会、签约、离队带来的实力变化（每场净胜分）"
        />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>球队高阶数据 <span className="sub">{meta.priorSeason}</span></h2>
          <div className="grid cols-3">
            <StatTile label="进攻效率" value={num(team.adv.offRtg)} hint="每百回合得分" />
            <StatTile label="防守效率" value={num(team.adv.defRtg)} hint="每百回合失分" />
            <StatTile label="净效率" value={signed(team.adv.netRtg)} />
            <StatTile label="节奏" value={num(team.adv.pace)} hint="每 48 分钟回合数" />
            <StatTile label="真实命中率" value={`${rate(team.adv.tsPct)}%`} />
            <StatTile label="助攻率" value={`${rate(team.adv.astPct)}%`} />
          </div>
          <div className="divider" />
          <h2 style={{ marginBottom: 10 }}>四要素 <span className="sub">己方 vs 对手</span></h2>
          <FourFactors ff={team.fourFactors} />
        </div>

        <div className="card">
          <h2>球队基础数据 <span className="sub">场均</span></h2>
          <div className="grid cols-3">
            <StatTile label="得分" value={num(team.base.pts)} />
            <StatTile label="篮板" value={num(team.base.reb)} />
            <StatTile label="助攻" value={num(team.base.ast)} />
            <StatTile label="抢断" value={num(team.base.stl)} />
            <StatTile label="盖帽" value={num(team.base.blk)} />
            <StatTile label="失误" value={num(team.base.tov)} />
            <StatTile label="投篮命中率" value={`${rate(team.base.fgPct)}%`} />
            <StatTile label="三分命中率" value={`${rate(team.base.fg3Pct)}%`} />
            <StatTile label="罚球命中率" value={`${rate(team.base.ftPct)}%`} />
          </div>
          <div className="divider" />
          <h2 style={{ marginBottom: 10 }}>得分构成</h2>
          <div className="grid cols-3">
            <StatTile label="三分占比" value={`${rate(team.scoring.pct3pt)}%`} />
            <StatTile label="内线占比" value={`${rate(team.scoring.pctPaint)}%`} />
            <StatTile label="快攻占比" value={`${rate(team.scoring.pctFastBreak)}%`} />
          </div>
        </div>
      </div>

      <div className="card">
        <h2>
          阵容
          <span className="sub">{roster.length} 人 · 勾选表示缺阵，会实时影响全站预测</span>
          <span style={{ marginLeft: 'auto' }}>
            <Segmented
              value={statMode}
              onChange={setStatMode}
              options={[{ value: 'base', label: '基础数据' }, { value: 'adv', label: '高阶数据' }]}
            />
          </span>
        </h2>
        {outIds.length > 0 && (
          <div className="err" style={{ background: 'rgba(240,136,62,.1)', borderColor: 'rgba(240,136,62,.3)', color: 'var(--accent)' }}>
            {outIds.length} 名球员标记为缺阵，球队实力修正 {signed(ranking.rosterAdj, 2)} 分/场
          </div>
        )}
        <PlayerTable
          rows={roster}
          mode={statMode}
          nameColumn={{
            key: 'name', label: '球员', align: 'left', width: 220,
            render: (p) => (
              <span className="player-row">
                <input
                  type="checkbox"
                  title="标记缺阵"
                  checked={outIds.includes(p.playerId)}
                  onChange={() => toggleOut(teamId, p.playerId)}
                  onClick={(e) => e.stopPropagation()}
                />
                <span style={{ opacity: outIds.includes(p.playerId) ? 0.42 : 1 }}>
                  {p.name}
                  {p.noPriorData && <span className="chip" style={{ marginLeft: 6 }}>无上季数据</span>}
                </span>
              </span>
            ),
          }}
          extraColumns={[
            { key: 'number', label: '号', width: 40, render: (p) => <span className="dim">{p.number}</span> },
            { key: 'posCn', label: '位置', width: 76, align: 'left', render: (p) => <span className="dim">{p.posCn || '—'}</span> },
            { key: 'age', label: '年龄', width: 48, render: (p) => num(p.age, 0) },
          ]}
        />
      </div>

      <div className="card">
        <h2>
          阵容更迭
          <span className="sub">
            转入 {arrivals.length} 人 · 转出 {departures.length} 人 ·
            合计 {signed(ranking.turnoverAdj, 2)} 分/场
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
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
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

/** 转入/转出名单：显示球员、原属/现属球队、上赛季产出与模型估值 */
function MoveList({ title, tone, rows, teamById, from }) {
  if (!rows.length) return <div><b style={{ fontSize: 13 }}>{title}</b><div className="empty">无</div></div>;
  return (
    <div>
      <b style={{ fontSize: 13 }} className={tone}>{title}</b>
      <div className="scroll-y" style={{ maxHeight: 300, marginTop: 6 }}>
        <table className="data">
          <tbody>
            {rows.map((p) => {
              const other = teamById.get(from ? p.priorTeamId : p.teamId);
              return (
                <tr key={p.playerId}>
                  <td className="left" style={{ width: 150 }}>{p.name}</td>
                  <td className="left dim" style={{ width: 90, fontSize: 11 }}>
                    {p.noPriorData
                      ? <span className="chip">新秀/无数据</span>
                      : other ? `${from ? '来自' : '去往'} ${other.abbr}` : (from ? '自由球员' : '离开联盟')}
                  </td>
                  <td className="dim" style={{ width: 78, fontSize: 11 }}>
                    {p.gp ? `${p.gp}场 ${num(p.min)}分` : '—'}
                  </td>
                  <td style={{ width: 56 }} className="mono">
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

function FourFactors({ ff }) {
  const rows = [
    { i: 1, label: '有效命中率', own: ff.efgPct, opp: ff.oppEfgPct, better: 'high' },
    { i: 2, label: '失误率', own: ff.tovPct, opp: ff.oppTovPct, better: 'low' },
    { i: 3, label: '前场篮板率', own: ff.orebPct, opp: ff.oppOrebPct, better: 'high' },
    { i: 4, label: '罚球造犯规率', own: ff.ftaRate, opp: ff.oppFtaRate, better: 'high' },
  ];
  return (
    <DataTable
      columns={[
        // 按四要素的公认权重顺序固定排列，而不是按中文名排序
        { key: 'label', label: '要素', align: 'left', width: 110, value: (r) => r.i, render: (r) => r.label },
        { key: 'own', label: '己方', width: 70, render: (r) => `${rate(r.own)}%` },
        { key: 'opp', label: '对手', width: 70, render: (r) => `${rate(r.opp)}%` },
        {
          key: 'diff', label: '优势', width: 70,
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

function TeamSchedule({ games, teamId, teamById }) {
  return (
    <DataTable
      maxHeight={560}
      rows={games}
      rowKey={(g) => g.gameId}
      initialSort={{ key: 'date', dir: 'asc' }}
      onRowClick={(g) => go(`predict/${g.awayId}/${g.homeId}/${g.gameId}`)}
      columns={[
        { key: 'date', label: '日期', align: 'left', width: 116, render: (g) => <span className="dim">{fmtDate(g.date)}</span> },
        {
          key: 'opp', label: '对手', align: 'left', width: 210,
          value: (g) => (g.homeId === teamId ? g.awayAbbr : g.homeAbbr),
          render: (g) => {
            const home = g.homeId === teamId;
            const opp = teamById.get(home ? g.awayId : g.homeId);
            return (
              <span className="team-cell">
                <span className="ab" style={{ width: 20 }}>{home ? 'vs' : '@'}</span>
                <TeamCell team={opp} size={20} showAbbr={false} />
              </span>
            );
          },
        },
        {
          key: 'rest', label: '休息', width: 66,
          value: (g) => (g.homeId === teamId ? g.prediction.restHome : g.prediction.restAway),
          render: (g) => {
            const r = g.homeId === teamId ? g.prediction.restHome : g.prediction.restAway;
            return <span className={r === 0 ? 'neg' : 'dim'}>{restLabel(r)}</span>;
          },
        },
        {
          key: 'win', label: '预测胜率', width: 120,
          value: (g) => (g.homeId === teamId ? g.prediction.homeWinProb : 1 - g.prediction.homeWinProb),
          render: (g) => {
            const p = g.homeId === teamId ? g.prediction.homeWinProb : 1 - g.prediction.homeWinProb;
            return (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <ProbBar p={p} width={52} />
                <b className="mono" style={{ color: probColor(p) }}>{(p * 100).toFixed(0)}%</b>
              </span>
            );
          },
        },
        {
          key: 'score', label: '预测比分', width: 96,
          value: (g) => (g.homeId === teamId ? g.prediction.margin : -g.prediction.margin),
          render: (g) => {
            const own = g.homeId === teamId ? g.prediction.homeScore : g.prediction.awayScore;
            const opp = g.homeId === teamId ? g.prediction.awayScore : g.prediction.homeScore;
            return <span className="mono">{own.toFixed(0)} - {opp.toFixed(0)}</span>;
          },
        },
        { key: 'label', label: '备注', align: 'left', width: 160, render: (g) => (g.label ? <span className="chip blue">{g.label}</span> : <span className="dim">{g.national?.join('/') || ''}</span>) },
      ]}
    />
  );
}
