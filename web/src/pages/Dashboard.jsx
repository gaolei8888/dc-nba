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

const MINUTES_SOURCE_CN = { 'current+prior': '本季→上季收缩', 'current+population': '本季→均值收缩', 'prior-season': '上季轮换' };
const IMPACT_SOURCE_CN = { 'current-blended': '本季混合', 'prior-season': '上季', 'estimated-shrunk-spm': '小样本收缩估计',
  'estimated-rookie-prior': '新秀先验', 'estimated-population-prior': '低分钟人群先验', 'replacement-prior': '替补级先验' };

export default function Dashboard() {
  const { meta, teamById, out, params, setAccent } = useApp();
  const [data, setData] = useState({ loading: true });
  const [rankingModel, setRankingModel] = useState('roster');
  const [availability, setAvailability] = useState('reported');
  const [selectedTeam, setSelectedTeam] = useState(null);
  // 实力榜的分组方式：全联盟 / 东西部 / 六赛区
  const [groupBy, setGroupBy] = useState('league');

  useEffect(() => { setAccent(null); }, [setAccent]);

  useEffect(() => {
    let alive = true;
    setData((d) => ({ ...d, loading: true }));
    Promise.all([
      api.rankings(withOut({ ...params, rankingModel, availability }, out)),
      // 今日比赛预览：从昨天（美东）起取一批，挑出北京时间今天或之后的第一个比赛日
      api.schedule(withOut({ ...params, type: 'all', from: shiftDate(bjToday(), -1), limit: 40 }, out)),
    ])
      .then(([rankings, schedule]) => alive && setData({ loading: false, rankings, schedule }))
      .catch((error) => alive && setData({ loading: false, error }));
    return () => { alive = false; };
  }, [params, out, meta, rankingModel, availability]);

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const { rankings } = data;
  // 按已加载的数据判断模式：切换开关后、重新请求完成前，rankings 仍是旧模式的行
  const rosterMode = rankings[0]?.model === 'roster';
  const detail = rosterMode ? rankings.find((r) => r.teamId === selectedTeam) : null;
  const validRankings = rankings.filter((r) => r.total != null);
  const selectTeam = (r) => rosterMode ? setSelectedTeam(r.teamId) : go(`team/${r.teamId}`);
  const upcomingGames = data.schedule.games
    .filter((g) => g.type !== 'preseason' && g.homeScore == null && bjDateOf(g.dateTimeUtc) >= bjToday());
  const nextDay = upcomingGames[0] ? bjDateOf(upcomingGames[0].dateTimeUtc) : null;
  const dayGames = upcomingGames.filter((g) => bjDateOf(g.dateTimeUtc) === nextDay);
  const east = validRankings.filter((t) => t.conference === 'East');
  const west = validRankings.filter((t) => t.conference === 'West');
  const improvementField = rosterMode ? 'modelDelta' : 'turnoverAdj';
  const mostImproved = [...validRankings].sort((a, b) => b[improvementField] - a[improvementField])[0];

  const grouped = groupBy !== 'league';

  const cols = [
    {
      key: 'rank', label: '#', width: 38,
      // 分组时这一列是组内名次，联盟名次单独一列，方便跨组比较
      render: (r) => <span className="dim">{(grouped ? r.groupRank : r.rank) ?? '—'}</span>,
      value: (r) => (grouped ? r.groupRank : r.rank),
    },
    {
      key: 'cn', label: '球队', align: 'left', width: 196,
      render: (r) => <TeamCell team={teamById.get(r.teamId)} onClick={() => selectTeam(r)} />,
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
      key: "total", label: <Th abbr="RTG" cn={rosterMode ? '阵容+战绩' : '综合实力'} />, title: rosterMode ? '阵容先验 + 本季战绩修正：(K·阵容先验 + n·对手调整净胜分)/(K+n)，相对联盟平均的每场分差' : '综合实力 RTG — 相对联盟平均的每场净胜分预期', width: 92,
      render: (r) => <b className={signClass(r.total)}>{signed(r.total, 2)}</b>,
    },
    ...(rosterMode ? [
      { key: 'priorTotal', label: <Th abbr="PRI" cn="阵容先验" />, width: 82, title: '只看当前名单 IMP × 预计分钟（含已报缺阵），不看比赛结果',
        render: (r) => <span className={signClass(r.priorTotal)}>{signed(r.priorTotal, 2)}</span> },
      { key: 'resultsAdj', label: <Th abbr="RES" cn="战绩修正" />, width: 82,
        title: '本季已赛结果（按对手强度与主场调整的净胜分）带来的修正；已赛越多，修正越大',
        render: (r) => r.resultsAdj == null ? <span className="dim">—</span>
          : <span className={signClass(r.resultsAdj)} title={`已赛 ${r.rosterProjection?.results?.games ?? 0} 场，对手调整净胜分 ${signed(r.rosterProjection?.results?.adjResult, 2)}`}>{signed(r.resultsAdj, 2)}</span> },
      { key: 'legacyRank', label: '旧名次', width: 64, title: '旧 Elo 综合模型的联盟名次，仅供对照', render: (r) => <span className="dim">{r.legacyRank}</span> },
      { key: 'legacyTotal', label: <Th abbr="OLD" cn="旧模型分" />, width: 82, render: (r) => <span className="dim">{signed(r.legacyTotal, 2)}</span> },
      { key: 'coverage', label: 'IMP 覆盖', width: 82, title: '预计240分钟中使用实测IMP（本季混合或上季）的占比；其余为样本收缩估计（未验证）', value: (r) => r.rosterProjection?.knownImpactPct,
        render: (r) => r.rosterProjection?.error ? <span className="neg" title={r.rosterProjection.error}>数据不足</span> : <span className="dim">{num(r.rosterProjection.knownImpactPct * 100, 0)}%</span> },
    ] : [{ key: "elo", label: <Th abbr="ELO" cn="评级" />, title: "Elo 评级", width: 66, render: (r) => <span className="mono">{num(r.elo, 0)}</span> }]),
    {
      key: "netRtg", label: <Th abbr="NET" cn="净效率" />, title: "净效率 NET — 本赛季至今百回合净效率", width: 82,
      render: (r) => <span className={signClass(r.netRtg)}>{signed(r.netRtg)}</span>,
    },
    ...(!rosterMode ? [{
      key: "turnoverAdj", label: <Th abbr="ROS" cn="阵容更迭" />, width: 82,
      title: "阵容更迭 ROS — 转会、签约、离队带来的实力变化",
      render: (r) => <span className={signClass(r.turnoverAdj)}>{signed(r.turnoverAdj, 2)}</span>,
    }] : []),
    {
      key: "rosterAdj", label: <Th abbr="OUT" cn="缺阵修正" />, title: rosterMode ? '相对全员健康阵容的变化，缺阵分钟由队友顶上' : '缺阵修正 OUT — 勾掉的球员对实力的影响', width: 82,
      render: (r) => (r.rosterAdj
        ? <span className={signClass(r.rosterAdj)}>{signed(r.rosterAdj, 2)}</span>
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
          {rosterMode ? '阵容先验（当前名单 × 球员 IMP × 预计上场分钟）+ 本季战绩修正；下方可切换旧 Elo 模型对照。'
            : `以 ${meta.priorSeason} 赛季比赛为基准，持续吸收本赛季赛果的 Elo 实力评级。`}
        </p>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <LeaderTile label={rosterMode ? '阵容+战绩最高' : '联盟最强'} row={validRankings[0]} teamById={teamById} />
        <LeaderTile label="东部领头" row={east[0]} teamById={teamById} />
        <LeaderTile label="西部领头" row={west[0]} teamById={teamById} />
        <LeaderTile label={rosterMode ? '相对旧模型上调最多' : '夏窗补强最多'} row={mostImproved} teamById={teamById} field={improvementField} />
      </div>

      <div className="card">
        <h2>
          球队实力榜
          <span className="sub">{rosterMode ? `阵容先验 + 本季战绩修正（K=${rankings[0]?.rosterProjection?.results?.k ?? '—'}）` : '旧 Elo 综合模型'}</span>
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

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <Segmented value={rankingModel} onChange={setRankingModel} options={[
            { value: 'roster', label: '阵容 + 战绩（实验）' }, { value: 'elo', label: '旧 Elo 对照' },
          ]} />
          {rosterMode && <Segmented value={availability} onChange={setAvailability} options={[
            { value: 'reported', label: '计入已报缺阵' }, { value: 'healthy', label: '忽略已报伤病' },
          ]} />}
        </div>
        {rosterMode && <p className="note" style={{ marginBottom: 14 }}>
          实力 = 阵容先验 + 本季战绩修正：r = (K·阵容先验 + n·对手调整净胜分) / (K + n)，K = {rankings[0]?.rosterProjection?.results?.k ?? '—'}，
          即阵容先验「值 {rankings[0]?.rosterProjection?.results?.k ?? '—'} 场比赛」，已赛 n 场时先验权重 K/(K+n)，战绩越多越看结果。
          对手调整：净胜分先扣主场优势（中立场不扣），再加上对手在本榜的强度。
          近期加权：每场按 0.4^(距今天数/60) 计权（约 60 天前的比赛按 0.4 场算），n 为加权场数。<br />
          阵容先验：现役名单按本季场均分钟分配 240 分钟；尚未出场者沿用上季轮换分钟。IMP 缺失者用样本收缩估计，覆盖率见表。
          球队旧 Elo 不参与本表评分。点击球队查看分钟与球员贡献。<br />
          K 与近期加权由 2022-23~2025-26 留一赛季回测选出：胜率 log loss 比只看阵容低 0.031（显著）；比旧 Elo 低 0.004（留一赛季显著，最终留出季 −0.002 不显著）。
          比赛预测与赛季模拟仍使用原 Elo 模型。
          手动缺阵始终保留。统计时间：{meta.statsFetchedAt ?? meta.fetchedAt}；伤病时间：{rankings[0]?.rosterProjection?.injuryFetchedAt ?? '未知'}。
        </p>}

        {groupBy === 'league' ? (
          <DataTable
            key={`${rankingModel}-${availability}`}
            columns={cols}
            rows={rankings}
            initialSort={{ key: 'total', dir: 'desc' }}
            rowKey={(r) => r.teamId}
            onRowClick={selectTeam}
          />
        ) : (
          groupsOf(rankings, groupBy).map(([label, rows]) => (
            <div key={label} style={{ marginBottom: 16 }}>
              <div className="group-head">
                {label}
                <span>{rows.length} 队 · 最强 {rows[0].cn} {signed(rows[0].total, 1)}</span>
              </div>
              <DataTable
                key={`${rankingModel}-${availability}-${label}`}
                columns={cols}
                rows={rows}
                initialSort={{ key: 'total', dir: 'desc' }}
                rowKey={(r) => r.teamId}
                onRowClick={selectTeam}
              />
            </div>
          ))
        )}
      </div>

      {detail && <div className="card">
        <h2>{detail.cn} · 预计轮换
          <span className="sub">阵容+战绩 {signed(detail.total, 2)} = 阵容先验 {signed(detail.priorTotal, 2)} + 战绩修正 {signed(detail.resultsAdj, 2)} · 旧模型 {signed(detail.legacyTotal, 2)} 分/场</span>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => go(`team/${detail.teamId}`)}>球队详情 ›</button>
        </h2>
        {detail.rosterProjection.error ? <p className="note">{detail.rosterProjection.error}</p> : <>
          {detail.rosterProjection.results && <p className="note">本季已赛 {detail.rosterProjection.results.games} 场，
            近期加权后折合 {num(detail.rosterProjection.results.effectiveGames, 1)} 场，
            对手与主场调整后场均净胜 {detail.rosterProjection.results.adjResult == null ? '—' : signed(detail.rosterProjection.results.adjResult, 2)} 分；
            阵容先验权重 {num(detail.rosterProjection.results.priorWeight * 100, 0)}%（K={detail.rosterProjection.results.k}），战绩权重 {num((1 - detail.rosterProjection.results.priorWeight) * 100, 0)}%。</p>}
          <p className="note">IMP 来源（占预计分钟）：{Object.entries(detail.rosterProjection.impactSourceShares ?? {})
            .map(([k, v]) => `${IMPACT_SOURCE_CN[k] ?? k} ${num(v * 100, 0)}%`).join('、')}。估计值未经回测验证。</p>
          <p className="note">预计总分钟 240；{availability === 'reported' ? '已报缺阵和手动勾选' : '手动勾选'}球员的分钟由其余名单球员分担。
            分钟是按现有角色归一化的估计，未加入新秀成长或阵容磨合假设。</p>
          <DataTable rows={detail.rosterProjection.rotation} rowKey={(p) => p.playerId}
            initialSort={{ key: 'minutes', dir: 'desc' }} maxHeight={360} columns={[
              { key: 'name', label: '球员', align: 'left' },
              { key: 'minutes', label: '预计分钟', render: (p) => num(p.minutes, 1) },
              { key: 'impact', label: 'IMP', render: (p) => <span title={p.impactPrior?.source}>{signed(p.impact, 2)}{p.fromPrior ? '（估计）' : ''}</span> },
              { key: 'contribution', label: '贡献 / 百回合', value: (p) => p.impact * p.minutes / 48,
                render: (p) => signed(p.impact * p.minutes / 48, 2) },
              { key: 'minutesSource', label: '分钟依据', render: (p) => p.availability === 0 ? '缺阵'
                : MINUTES_SOURCE_CN[p.minutesSource] ?? '替补分配' },
            ]} />
        </>}
      </div>}

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
        <h2>{rosterMode ? '旧 Elo 对照模型说明（比赛预测与模拟）' : '模型说明'}</h2>
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
        .sort((a, b) => (b.total ?? -Infinity) - (a.total ?? -Infinity))
        .map((t, i) => ({ ...t, groupRank: t.total == null ? null : i + 1 })),
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
