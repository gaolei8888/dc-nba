import React, { useEffect, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api, withOut } from '../lib/api.js';
import {
  DataTable, TeamCell, TeamLogo, Loading, ErrorBox, ProbBar, Segmented, Th,
} from '../components/common.jsx';
import {
  num, signed, signClass, fmtDate, probColor, CONF_CN, DIV_CN, DIV_ORDER,
  bjToday, bjDateOf, bjTimeOf, shiftDate,
} from '../lib/format.js';

export default function Dashboard() {
  const { meta, teamById, out, params, setAccent } = useApp();
  const [data, setData] = useState({ loading: true });
  // 实力榜的分组方式：全联盟 / 东西部 / 六赛区
  const [groupBy, setGroupBy] = useState('conference');

  useEffect(() => { setAccent(null); }, [setAccent]);

  useEffect(() => {
    let alive = true;
    setData((d) => ({ ...d, loading: true }));
    Promise.all([
      api.rankings(withOut(params, out)),
      // 今日比赛预览：从昨天（美东）起取一批，挑出北京时间今天或之后的第一个比赛日
      api.schedule(withOut({ ...params, type: 'all', from: shiftDate(bjToday(), -1), limit: 40 }, out)),
    ])
      .then(([rankings, schedule]) => alive && setData({ loading: false, rankings, schedule }))
      .catch((error) => alive && setData({ loading: false, error }));
    return () => { alive = false; };
  }, [params, out, meta]);

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const { rankings } = data;
  const upcomingGames = data.schedule.games
    .filter((g) => g.type !== 'preseason' && g.homeScore == null && bjDateOf(g.dateTimeUtc) >= bjToday());
  const nextDay = upcomingGames[0] ? bjDateOf(upcomingGames[0].dateTimeUtc) : null;
  const dayGames = upcomingGames.filter((g) => bjDateOf(g.dateTimeUtc) === nextDay);
  const east = rankings.filter((t) => t.conference === 'East');
  const west = rankings.filter((t) => t.conference === 'West');
  const mostImproved = [...rankings].sort((a, b) => b.turnoverAdj - a.turnoverAdj)[0];

  const grouped = groupBy !== 'league';

  const cols = [
    {
      key: 'rank', label: '#', width: 38,
      // 分组时这一列是组内名次，联盟名次单独一列，方便跨组比较
      render: (r) => <span className="dim">{grouped ? r.groupRank : r.rank}</span>,
      value: (r) => (grouped ? r.groupRank : r.rank),
    },
    {
      key: 'cn', label: '球队', align: 'left', width: 196,
      render: (r) => <TeamCell team={teamById.get(r.teamId)} onClick={() => go(`team/${r.teamId}`)} />,
    },
    ...(grouped
      ? [{
        key: 'leagueRank', label: '联盟', title: '联盟总排名', width: 48,
        value: (r) => r.rank,
        render: (r) => <span className="dim">{r.rank}</span>,
      }]
      : [
        { key: 'conference', label: '分区', width: 52, render: (r) => CONF_CN[r.conference] },
        { key: 'division', label: '赛区', width: 62, render: (r) => <span className="dim">{DIV_CN[r.division] ?? r.division}</span> },
      ]),
    {
      key: "total", label: <Th abbr="RTG" cn="综合实力" />, title: "综合实力 RTG — 相对联盟平均的每场净胜分预期", width: 92,
      render: (r) => <b className={signClass(r.total)}>{signed(r.total, 2)}</b>,
    },
    { key: "elo", label: <Th abbr="ELO" cn="评级" />, title: "Elo 评级", width: 66, render: (r) => <span className="mono">{num(r.elo, 0)}</span> },
    {
      key: "netRtg", label: <Th abbr="NET" cn="净效率" />, title: "净效率 NET — 本赛季至今百回合净效率", width: 82,
      render: (r) => <span className={signClass(r.netRtg)}>{signed(r.netRtg)}</span>,
    },
    {
      key: "turnoverAdj", label: <Th abbr="ROS" cn="阵容更迭" />, width: 82,
      title: "阵容更迭 ROS — 转会、签约、离队带来的实力变化",
      render: (r) => <span className={signClass(r.turnoverAdj)}>{signed(r.turnoverAdj, 2)}</span>,
    },
    {
      key: "rosterAdj", label: <Th abbr="OUT" cn="缺阵修正" />, title: "缺阵修正 OUT — 勾掉的球员对实力的影响", width: 82,
      render: (r) => (r.rosterAdj
        ? <span className="neg">{signed(r.rosterAdj, 2)}</span>
        : <span className="dim">—</span>),
    },
    { key: "offRtg", label: <Th abbr="ORtg" cn="进攻" />, title: "进攻效率 ORtg", width: 64, render: (r) => num(r.offRtg) },
    { key: "defRtg", label: <Th abbr="DRtg" cn="防守" />, title: "防守效率 DRtg", width: 64, render: (r) => num(r.defRtg) },
    { key: "pace", label: <Th abbr="PACE" cn="节奏" />, title: "节奏 PACE", width: 64, render: (r) => num(r.pace) },
    {
      key: 'record', label: `${(meta.displayCurrent ? meta.targetSeason : meta.priorSeason)} 战绩`, width: 90,
      render: (r) => <span className="mono dim">{r.record ?? r.priorRecord}</span>,
    },
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

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <LeaderTile label="联盟最强" row={rankings[0]} teamById={teamById} />
        <LeaderTile label="东部领头" row={east[0]} teamById={teamById} />
        <LeaderTile label="西部领头" row={west[0]} teamById={teamById} />
        <LeaderTile label="夏窗补强最多" row={mostImproved} teamById={teamById} field="turnoverAdj" />
      </div>

      <div className="card">
        <h2>
          球队实力榜
          <span className="sub">综合 Elo、净效率、阵容更迭与当前缺阵</span>
          <span style={{ marginLeft: 'auto' }}>
            <Segmented
              value={groupBy}
              onChange={setGroupBy}
              options={[
                { value: 'conference', label: '东西部' },
                { value: 'division', label: '六赛区' },
                { value: 'league', label: '全联盟' },
              ]}
            />
          </span>
        </h2>

        {groupBy === 'league' ? (
          <DataTable
            columns={cols}
            rows={rankings}
            initialSort={{ key: 'total', dir: 'desc' }}
            rowKey={(r) => r.teamId}
            onRowClick={(r) => go(`team/${r.teamId}`)}
          />
        ) : (
          groupsOf(rankings, groupBy).map(([label, rows]) => (
            <div key={label} style={{ marginBottom: 16 }}>
              <div className="group-head">
                {label}
                <span>{rows.length} 队 · 最强 {rows[0].cn} {signed(rows[0].total, 1)}</span>
              </div>
              <DataTable
                columns={cols}
                rows={rows}
                initialSort={{ key: 'total', dir: 'desc' }}
                rowKey={(r) => r.teamId}
                onRowClick={(r) => go(`team/${r.teamId}`)}
              />
            </div>
          ))
        )}
      </div>

      {dayGames.length > 0 && (
        <div className="card">
          <h2>
            {nextDay === bjToday() ? '今日比赛预测' : '下一个比赛日'}
            <span className="sub">{fmtDate(nextDay)} · 北京时间 · {dayGames.length} 场</span>
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => go(`today/${nextDay}`)}>
              全部详情 ›
            </button>
          </h2>
          <div className="grid cols-3">
            {dayGames.slice(0, 6).map((g) => <GameCard key={g.gameId} game={g} teamById={teamById} />)}
          </div>
        </div>
      )}

      <div className="card plain">
        <h2>模型说明</h2>
        <p className="note">
          <b>综合实力</b> = Elo 折算分 × {num(meta.defaultParams.wElo, 2)} + 净效率折算分 × {num(meta.defaultParams.wNet, 2)}
          + 阵容更迭 + 缺阵修正，单位是相对联盟平均的每场净胜分。<br />
          <b>Elo</b> 由上赛季逐场结果迭代得出（含分差放大项），赛季间向 1500 回归 25%，
          之后继续吸收本赛季已完成比赛（当前 {meta.gamesPlayedCurrent ?? 0} 场）。
          回测显示这一步把胜负准确率从 61.4% 提升到 66.3%。<br />
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

/**
 * 按分区或赛区分组，组内按实力排序并标上组内名次。
 * 东部三个赛区排在西部前面，和联盟官方的呈现顺序一致。
 */
function groupsOf(rankings, mode) {
  const keyOf = (t) => (mode === 'conference'
    ? CONF_CN[t.conference]
    : DIV_CN[t.division] ?? t.division);
  const order = mode === 'conference' ? ['东部', '西部'] : DIV_ORDER;

  const map = new Map();
  for (const t of rankings) {
    const k = keyOf(t);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return order
    .filter((k) => map.has(k))
    .map((k) => [
      k,
      map.get(k)
        .slice()
        .sort((a, b) => b.total - a.total)
        .map((t, i) => ({ ...t, groupRank: i + 1 })),
    ]);
}

/** 带队标的领先者数据块 */
function LeaderTile({ label, row, teamById, field = 'total' }) {
  if (!row) return null;
  const team = teamById.get(row.teamId);
  return (
    <div className="tile" style={{ cursor: 'pointer' }} onClick={() => go(`team/${row.teamId}`)}>
      <div className="k">{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 7 }}>
        <TeamLogo team={team} size={34} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 720, fontSize: 15, letterSpacing: '-.2px' }}>{team?.cn}</div>
          <div className={`mono ${signClass(row[field])}`} style={{ fontSize: 12, fontWeight: 700 }}>
            {signed(row[field], 2)} 分/场
          </div>
        </div>
      </div>
    </div>
  );
}

function GameCard({ game, teamById }) {
  const home = teamById.get(game.homeId);
  const away = teamById.get(game.awayId);
  const p = game.prediction;
  const homeFav = p.homeWinProb >= 0.5;
  const winner = homeFav ? home : away;

  return (
    <div
      className="game-card"
      onClick={() => go(`predict/${game.awayId}/${game.homeId}/${game.gameId}`)}
    >
      <div className="top">
        <span>{bjTimeOf(game.dateTimeUtc)} 开打</span>
        <span>{game.national?.join(' / ') || game.arena}</span>
      </div>
      <Side team={away} score={p.awayScore} bold={!homeFav} />
      <div style={{ height: 6 }} />
      <Side team={home} score={p.homeScore} bold={homeFav} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <ProbBar p={p.homeWinProb} width="100%" />
        <span
          className="mono"
          style={{
            color: probColor(p.homeWinProb), fontWeight: 700,
            fontSize: 12, whiteSpace: 'nowrap',
          }}
        >
          {winner?.abbr} {(Math.max(p.homeWinProb, 1 - p.homeWinProb) * 100).toFixed(0)}%
        </span>
      </div>
    </div>
  );
}

function Side({ team, score, bold }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <TeamLogo team={team} size={22} />
      <span
        style={{
          flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap', fontSize: 13,
          fontWeight: bold ? 700 : 400,
          color: bold ? 'var(--text)' : 'var(--text-dim)',
        }}
      >
        {team?.cn}
      </span>
      <span
        className="mono"
        style={{ fontWeight: bold ? 750 : 500, color: bold ? 'var(--text)' : 'var(--text-dim)' }}
      >
        {score.toFixed(0)}
      </span>
    </div>
  );
}
