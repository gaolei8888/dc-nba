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

const MINUTES_SOURCE_CN = { 'current+prior': '本季→上季收缩', 'current+population': '本季→均值收缩', 'prior-season': '上季轮换',
  'dnp-benched': '轮换外（本季未出场）', replacement: '无分钟信息' };
const STATUS_CN = { out: '缺阵', doubtful: '可能缺阵', dayToDay: '每日观察' };
/** 伤病快照的年龄（小时，按当前时间算；服务端结果有缓存，所以在界面里算） */
const ageHours = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 3600e3 : null);
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
  // 阵容榜的数据问题不再静默：IMP 模型缺失、伤病快照过期、个别球队算不出来
  const rp = rankings.find((r) => r.rosterProjection)?.rosterProjection;
  const injuryAge = ageHours(rp?.injuryFetchedAt);
  const failedTeams = rankings.filter((r) => r.rosterProjection?.error);
  const rosterNotices = !rp ? [] : [
    rp.impactModelMissing && '缺少 IMP 模型：没有 IMP 的球员全部按替补级 −0.5 计。',
    availability === 'reported' && !rp.injuryFetchedAt && '没有伤病快照：已报伤病未计入。',
    availability === 'reported' && rp.injuryFetchedAt && (rp.injuryStale || injuryAge > rp.injuryStaleHours)
      && `伤病快照已 ${num(injuryAge, 0)} 小时未更新，可能过期。`,
    failedTeams.length > 0 && `${failedTeams.map((r) => r.cn ?? r.teamId).join('、')} 数据不足，未参与排名。`,
  ].filter(Boolean);

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
      key: "total", label: <Th abbr="RTG" cn={rosterMode ? '阵容估计' : '综合实力'} />, title: rosterMode ? '当前阵容 IMP × 预计分钟；相对联盟平均（同一伤病口径）的每场分差，实验估计' : '综合实力 RTG — 相对联盟平均的每场净胜分预期', width: 92,
      render: (r) => <b className={signClass(r.total)}>{signed(r.total, 2)}</b>,
    },
    ...(rosterMode ? [
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
      key: "rosterAdj", label: <Th abbr="OUT" cn="缺阵修正" />, title: rosterMode ? '相对全员健康阵容的变化（按出场概率加权，空出的分钟主要由轮换中段与替补顶上）' : '缺阵修正 OUT — 勾掉的球员对实力的影响', width: 82,
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
          {rosterMode ? '按当前名单、球员 IMP 与预计上场分钟重算实力；下方可切换旧 Elo 模型对照。'
            : `以 ${meta.priorSeason} 赛季比赛为基准，持续吸收本赛季赛果的 Elo 实力评级。`}
        </p>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <LeaderTile label={rosterMode ? '阵容估计最高' : '联盟最强'} row={validRankings[0]} teamById={teamById} />
        <LeaderTile label="东部领头" row={east[0]} teamById={teamById} />
        <LeaderTile label="西部领头" row={west[0]} teamById={teamById} />
        <LeaderTile label={rosterMode ? '相对旧模型上调最多' : '夏窗补强最多'} row={mostImproved} teamById={teamById} field={improvementField} />
      </div>

      <div className="card">
        <h2>
          球队实力榜
          <span className="sub">{rosterMode ? '当前阵容 · 实验估计' : '旧 Elo 综合模型'}</span>
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
            { value: 'roster', label: '当前阵容（实验）' }, { value: 'elo', label: '旧 Elo 对照' },
          ]} />
          {rosterMode && <Segmented value={availability} onChange={setAvailability} options={[
            { value: 'reported', label: '计入已报缺阵' }, { value: 'healthy', label: '忽略已报伤病' },
          ]} />}
        </div>
        {rosterMode && rosterNotices.length > 0 && <p className="note neg" style={{ marginBottom: 8 }}>{rosterNotices.join(' ')}</p>}
        {rosterMode && <p className="note" style={{ marginBottom: 14 }}>
          现役名单按「出场时分钟 × 轮换概率 × 伤病出场概率」分配 240 分钟（单人期望上限 38；缺阵≈1%、可能缺阵≈6%、每日观察≈54% 出场，冻结参数）；
          本季一场未出、又不在伤病名单上的人视为轮换外。没有 IMP 的人用小样本收缩估计（上季均值 / 新秀均值 / 低分钟人群，未验证），覆盖率见表。
          球员 IMP 含历史信息，但球队旧 Elo 不参与本表评分。点击球队查看分钟与球员贡献。<br />
          这是实验估计（分钟分配做过历史回测，见 docs/roster-fixes-batch1-verdict.md）；<b>比赛胜率与赛季模拟来自 Elo 模型</b>，不是本表。
          手动缺阵始终保留。统计时间：{meta.statsFetchedAt ?? meta.fetchedAt}；伤病时间：{rp?.injuryFetchedAt ?? '未知'}{injuryAge != null ? `（${num(injuryAge, 0)} 小时前）` : ''}。
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
          <span className="sub">阵容 {signed(detail.total, 2)} · 旧模型 {signed(detail.legacyTotal, 2)} 分/场</span>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => go(`team/${detail.teamId}`)}>球队详情 ›</button>
        </h2>
        {detail.rosterProjection.error ? <p className="note">{detail.rosterProjection.error}</p> : <>
          <p className="note">IMP 来源（占预计分钟）：{Object.entries(detail.rosterProjection.impactSourceShares ?? {})
            .map(([k, v]) => `${IMPACT_SOURCE_CN[k] ?? k} ${num(v * 100, 0)}%`).join('、')}。估计值未经回测验证。</p>
          <p className="note">预计总分钟 240（含替补级 {num(detail.rosterProjection.replacementMinutes ?? 0, 1)}）；{availability === 'reported' ? '已报伤病按出场概率加权，手动勾选' : '手动勾选'}球员的分钟主要由轮换中段与替补分担。
            分钟是按现有角色的估计，未加入新秀成长或阵容磨合假设。</p>
          <DataTable rows={detail.rosterProjection.rotation} rowKey={(p) => p.playerId}
            initialSort={{ key: 'minutes', dir: 'desc' }} maxHeight={360} columns={[
              { key: 'name', label: '球员', align: 'left' },
              { key: 'minutes', label: '预计分钟', render: (p) => num(p.minutes, 1) },
              { key: 'play', label: '出场概率', title: '轮换概率 × 伤病出场概率', value: (p) => p.availability * (p.rotation ?? 1),
                render: (p) => <span className="dim" title={p.injuryStatus ? STATUS_CN[p.injuryStatus] ?? p.injuryStatus : undefined}>
                  {num(p.availability * (p.rotation ?? 1) * 100, 0)}%{p.injuryStatus ? `（${STATUS_CN[p.injuryStatus] ?? p.injuryStatus}）` : ''}</span> },
              { key: 'impact', label: 'IMP', render: (p) => <span title={p.impactPrior?.source}>{signed(p.impact, 2)}{p.fromPrior ? '（估计）' : ''}</span> },
              { key: 'contribution', label: '贡献 / 百回合', value: (p) => p.impact * p.minutes / 48,
                render: (p) => signed(p.impact * p.minutes / 48, 2) },
              { key: 'minutesSource', label: '分钟依据', render: (p) => p.availability === 0 ? '缺阵（手动）'
                : MINUTES_SOURCE_CN[p.minutesSource] ?? '替补分配' },
            ]} />
        </>}
      </div>}

      {dayGames.length > 0 && (
        <div className="card">
          <h2>
            {nextDay === bjToday() ? '今日比赛预测' : '下一个比赛日'}
            <span className="sub">{fmtDate(nextDay)} · 北京时间 · {dayGames.length} 场 · 胜率来自 Elo 模型</span>
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
