import React, { useEffect, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api, withOut } from '../lib/api.js';
import { DataTable, TeamCell, StatTile, Loading, ErrorBox, ProbBar } from '../components/common.jsx';
import { num, signed, signClass, fmtDate, probColor } from '../lib/format.js';

export default function Dashboard() {
  const { meta, teamById, out, params } = useApp();
  const [data, setData] = useState({ loading: true });

  useEffect(() => {
    let alive = true;
    setData((d) => ({ ...d, loading: true }));
    Promise.all([
      api.rankings(withOut(params, out)),
      api.schedule(withOut({ ...params, type: 'regular', limit: 12 }, out)),
    ])
      .then(([rankings, schedule]) => alive && setData({ loading: false, rankings, schedule }))
      .catch((error) => alive && setData({ loading: false, error }));
    return () => { alive = false; };
  }, [params, out, meta]);

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const { rankings } = data;
  const opening = data.schedule.games;
  const east = rankings.filter((t) => t.conference === 'East').slice(0, 5);
  const west = rankings.filter((t) => t.conference === 'West').slice(0, 5);

  const cols = [
    { key: 'rank', label: '#', width: 40, render: (r) => <span className="dim">{r.rank}</span> },
    {
      key: 'cn', label: '球队', align: 'left', width: 200,
      render: (r) => <TeamCell team={teamById.get(r.teamId)} onClick={() => go(`team/${r.teamId}`)} />,
    },
    { key: 'conference', label: '分区', width: 56, render: (r) => (r.conference === 'East' ? '东部' : '西部') },
    {
      key: 'total', label: '综合实力', title: '相对联盟平均的每场净胜分预期', width: 90,
      render: (r) => <b className={signClass(r.total)}>{signed(r.total, 2)}</b>,
    },
    { key: 'elo', label: 'Elo', width: 70, render: (r) => <span className="mono">{num(r.elo, 0)}</span> },
    { key: 'netPts', label: '净效率分', title: '上赛季百回合净效率折算到每场', width: 84, render: (r) => <span className={signClass(r.netPts)}>{signed(r.netPts)}</span> },
    {
      key: 'turnoverAdj', label: '阵容更迭', width: 84,
      title: '转会、签约、离队带来的实力变化',
      render: (r) => <span className={signClass(r.turnoverAdj)}>{signed(r.turnoverAdj, 2)}</span>,
    },
    { key: 'rosterAdj', label: '缺阵修正', width: 84, render: (r) => (r.rosterAdj ? <span className="neg">{signed(r.rosterAdj, 2)}</span> : <span className="dim">—</span>) },
    { key: 'offRtg', label: '进攻', width: 64, render: (r) => num(r.offRtg) },
    { key: 'defRtg', label: '防守', width: 64, render: (r) => num(r.defRtg) },
    { key: 'pace', label: '节奏', width: 64, render: (r) => num(r.pace) },
    { key: 'priorRecord', label: `${meta.priorSeason} 战绩`, width: 96, render: (r) => <span className="mono dim">{r.priorRecord}</span> },
  ];

  return (
    <>
      <div className="page-head">
        <h1>{meta.targetSeason} 赛季总览</h1>
        <p>
          以 {meta.priorSeason} 赛季 {meta.gamesPlayedPrior} 场比赛结果为基准建立的球队实力评级，
          用于预测 {meta.targetSeason} 赛季 {meta.counts.games} 场赛程。
        </p>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <StatTile label="联盟最强" value={rankings[0].cn} unit={`  ${signed(rankings[0].total, 1)}`} />
        <StatTile label="东部领头" value={east[0].cn} unit={`  ${signed(east[0].total, 1)}`} />
        <StatTile label="西部领头" value={west[0].cn} unit={`  ${signed(west[0].total, 1)}`} />
        <StatTile
          label="补强最多"
          value={[...rankings].sort((a, b) => b.turnoverAdj - a.turnoverAdj)[0].cn}
          unit={`  ${signed([...rankings].sort((a, b) => b.turnoverAdj - a.turnoverAdj)[0].turnoverAdj, 1)}`}
          hint="夏窗阵容更迭带来的实力变化"
        />
      </div>

      <div className="card">
        <h2>球队实力榜 <span className="sub">综合 Elo 与净效率，含当前缺阵修正</span></h2>
        <DataTable
          columns={cols}
          rows={rankings}
          initialSort={{ key: 'total', dir: 'desc' }}
          rowKey={(r) => r.teamId}
          onRowClick={(r) => go(`team/${r.teamId}`)}
        />
      </div>

      <div className="card">
        <h2>
          揭幕战预测
          <span className="sub">{opening[0] ? fmtDate(opening[0].date) : ''} 起</span>
        </h2>
        <div className="grid cols-2">
          {opening.map((g) => (
            <GameRow key={g.gameId} game={g} teamById={teamById} />
          ))}
        </div>
      </div>

      <div className="card">
        <h2>模型说明</h2>
        <p className="note">
          <b>综合实力</b> = Elo 折算分 × {num(meta.defaultParams.wElo, 2)} + 净效率折算分 × {num(meta.defaultParams.wNet, 2)}
          + 阵容更迭 + 缺阵修正，单位是相对联盟平均的每场净胜分。<br />
          <b>Elo</b> 由上赛季逐场结果迭代得出（含分差放大项），赛季间向 1500 回归 25%。<br />
          <b>轮换影响力</b> 按整季总出场分钟降序取球员、累计到球队总分钟上限，累加 (PIE − 替补级) × 分钟。
          用 30 队的「上赛季名单 → 上赛季净效率」拟合，R² = {meta.impactFit.r2.toFixed(3)}。<br />
          <b>阵容更迭</b> 是新名单与上赛季名单轮换影响力之差，联盟层面做零和归一，
          默认按 {num(meta.defaultParams.turnoverWeight, 2)} 的强度计入（新援磨合、年龄曲线未建模，故留有折扣）。<br />
          <b>缺阵修正</b> 把勾选的球员移出轮换后重算影响力，空出的时间由名单里排在后面的人顶上。<br />
          <b>假设全员健康</b>（侧栏开关）用场均分钟 × 70 场估算新赛季轮换，
          避免上赛季伤停的球星（塔图姆 16 场、字母哥 36 场、恩比德 38 场）被当成低产球员。<br />
          <b>胜率</b> 由预期分差经正态分布换算，单场分差标准差取 {num(meta.defaultParams.spreadSd)} 分。
        </p>
      </div>
    </>
  );
}

function GameRow({ game, teamById }) {
  const home = teamById.get(game.homeId);
  const away = teamById.get(game.awayId);
  const p = game.prediction;
  const homeFav = p.homeWinProb >= 0.5;
  return (
    <div
      className="stat-tile"
      style={{ cursor: 'pointer' }}
      onClick={() => go(`predict/${game.awayId}/${game.homeId}/${game.gameId}`)}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-faint)' }}>
        <span>{fmtDate(game.date)}</span>
        <span>{game.national?.join(' / ') || game.arena}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 7 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <TeamCell team={away} size={20} showAbbr={false} />
          <div style={{ height: 5 }} />
          <TeamCell team={home} size={20} showAbbr={false} />
        </div>
        <div className="mono" style={{ textAlign: 'right', color: 'var(--text-dim)' }}>
          <div style={{ fontWeight: homeFav ? 400 : 700, color: homeFav ? 'var(--text-dim)' : 'var(--text)' }}>
            {p.awayScore.toFixed(0)}
          </div>
          <div style={{ height: 5 }} />
          <div style={{ fontWeight: homeFav ? 700 : 400, color: homeFav ? 'var(--text)' : 'var(--text-dim)' }}>
            {p.homeScore.toFixed(0)}
          </div>
        </div>
        <div style={{ width: 74, textAlign: 'right' }}>
          <div className="mono" style={{ color: probColor(p.homeWinProb), fontWeight: 650 }}>
            {(Math.max(p.homeWinProb, 1 - p.homeWinProb) * 100).toFixed(0)}%
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            {homeFav ? home.abbr : away.abbr} 胜
          </div>
          <ProbBar p={p.homeWinProb} width="100%" />
        </div>
      </div>
    </div>
  );
}
