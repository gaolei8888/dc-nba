import React, { useEffect, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api, withOut } from '../lib/api.js';
import {
  DataTable, TeamCell, TeamLogo, Loading, ErrorBox, ProbBar, Segmented, Th,
} from '../components/common.jsx';
import { num, signed, signClass, probColor, shiftDate } from '../lib/format.js';
import { useI18n } from '../i18n/react.jsx';
import { tzToday, DIV_CODES } from '../i18n/fmt.js';
import { renderMsg, rosterSourceMsg } from '../i18n/msg.js';
import { gameDay, nextGameDay } from '../lib/gameDays.js';

/** 伤病快照的年龄（小时，按当前时间算；服务端结果有缓存，所以在界面里算） */
const ageHours = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 3600e3 : null);

export default function Dashboard() {
  const { meta, teamById, out, params, setAccent } = useApp();
  const { tz, t, fmt } = useI18n();
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
      // 今日比赛预览：从昨天（美东）起取一批，按所选时区挑出今天或之后的第一个比赛日（美东日期 >= 所选时区今天 - 1，所以 -1 天足够）
      api.schedule(withOut({ ...params, type: 'all', from: shiftDate(tzToday(tz), -1), limit: 40 }, out)),
    ])
      .then(([rankings, schedule]) => alive && setData({ loading: false, rankings, schedule }))
      .catch((error) => alive && setData({ loading: false, error }));
    return () => { alive = false; };
  }, [params, out, meta, rankingModel, availability, tz]);

  // 缺键时 t 返回键名本身：服务端给出了新枚举值时退回原值，不显示键名
  const tOr = (key, fallback) => { const v = t(key); return v === key ? fallback : v; };

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const { rankings } = data;
  // 按已加载的数据判断模式：切换开关后、重新请求完成前，rankings 仍是旧模式的行
  const rosterMode = rankings[0]?.model === 'roster';
  const detail = rosterMode ? rankings.find((r) => r.teamId === selectedTeam) : null;
  const validRankings = rankings.filter((r) => r.total != null);
  const selectTeam = (r) => rosterMode ? setSelectedTeam(r.teamId) : go(`team/${r.teamId}`);
  const nextDay = nextGameDay(data.schedule.games, tz);
  const dayGames = nextDay
    ? data.schedule.games.filter((g) => g.type !== 'preseason' && g.homeScore == null && gameDay(g, tz) === nextDay)
    : [];
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
    rp.impactModelMissing && t('dashboard.notice.noImpact'),
    availability === 'reported' && !rp.injuryFetchedAt && t('dashboard.notice.noInjury'),
    availability === 'reported' && rp.injuryFetchedAt && (rp.injuryStale || injuryAge > rp.injuryStaleHours)
      && t('dashboard.notice.injuryStale', { count: Math.round(injuryAge) }),
    failedTeams.length > 0 && t('dashboard.notice.failedTeams', {
      teams: new Intl.ListFormat(fmt.intl).format(failedTeams.map((r) => fmt.teamName(teamById.get(r.teamId)))),
    }),
  ].filter(Boolean);

  const cols = [
    {
      key: 'rank', label: '#', width: 38,
      // 分组时这一列是组内名次，联盟名次单独一列，方便跨组比较
      render: (r) => <span className="dim">{(grouped ? r.groupRank : r.rank) ?? '—'}</span>,
      value: (r) => (grouped ? r.groupRank : r.rank),
    },
    {
      key: 'cn', label: t('dashboard.col.team'), align: 'left', width: 196,
      render: (r) => <TeamCell team={teamById.get(r.teamId)} onClick={() => selectTeam(r)} />,
    },
    ...(grouped
      ? [{
        key: 'leagueRank', label: t('dashboard.col.league'), title: t('dashboard.col.leagueTip'), width: 48,
        value: (r) => r.rank,
        render: (r) => <span className="dim">{r.rank}</span>,
      }]
      : [
        { key: 'conference', label: t('dashboard.col.conf'), width: 52, render: (r) => fmt.conf(r.conference) },
        { key: 'division', label: t('dashboard.col.div'), width: 62, render: (r) => <span className="dim">{fmt.div(r.division)}</span> },
      ]),
    {
      key: "total", label: <Th abbr="RTG" label={rosterMode ? t('dashboard.col.rtgRoster') : t('dashboard.col.rtg')} />, title: rosterMode ? t('dashboard.col.rtgRosterTip') : t('dashboard.col.rtgTip'), width: 92,
      render: (r) => <b className={signClass(r.total)}>{signed(r.total, 2)}</b>,
    },
    ...(rosterMode ? [
      { key: 'priorTotal', label: <Th abbr="PRI" label={t('dashboard.col.pri')} />, width: 82, title: t('dashboard.col.priTip'),
        render: (r) => <span className={signClass(r.priorTotal)}>{signed(r.priorTotal, 2)}</span> },
      { key: 'resultsAdj', label: <Th abbr="RES" label={t('dashboard.col.res')} />, width: 82,
        title: t('dashboard.col.resTip'),
        render: (r) => r.resultsAdj == null ? <span className="dim">—</span>
          : <span className={signClass(r.resultsAdj)} title={t('dashboard.col.resCell', { games: r.rosterProjection?.results?.games ?? 0, adj: signed(r.rosterProjection?.results?.adjResult, 2) })}>{signed(r.resultsAdj, 2)}</span> },
      { key: 'legacyRank', label: t('dashboard.col.legacyRank'), width: 64, title: t('dashboard.col.legacyRankTip'), render: (r) => <span className="dim">{r.legacyRank}</span> },
      { key: 'legacyTotal', label: <Th abbr="OLD" label={t('dashboard.col.old')} />, width: 82, render: (r) => <span className="dim">{signed(r.legacyTotal, 2)}</span> },
      { key: 'coverage', label: t('dashboard.col.coverage'), width: 82, title: t('dashboard.col.coverageTip'), value: (r) => r.rosterProjection?.knownImpactPct,
        render: (r) => r.rosterProjection?.error ? <span className="neg" title={t(r.rosterProjection.errorCode ?? 'srv.roster.insufficient')}>{t('dashboard.col.insufficient')}</span> : <span className="dim">{num(r.rosterProjection.knownImpactPct * 100, 0)}%</span> },
    ] : [{ key: "elo", label: <Th abbr="ELO" label={t('dashboard.col.elo')} />, title: t('dashboard.col.eloTip'), width: 66, render: (r) => <span className="mono">{num(r.elo, 0)}</span> }]),
    {
      key: "netRtg", label: <Th abbr="NET" label={t('dashboard.col.net')} />, title: t('dashboard.col.netTip'), width: 82,
      render: (r) => <span className={signClass(r.netRtg)}>{signed(r.netRtg)}</span>,
    },
    ...(!rosterMode ? [{
      key: "turnoverAdj", label: <Th abbr="ROS" label={t('dashboard.col.ros')} />, width: 82,
      title: t('dashboard.col.rosTip'),
      render: (r) => <span className={signClass(r.turnoverAdj)}>{signed(r.turnoverAdj, 2)}</span>,
    }] : []),
    {
      key: "rosterAdj", label: <Th abbr="OUT" label={t('dashboard.col.out')} />, title: rosterMode ? t('dashboard.col.outRosterTip') : t('dashboard.col.outTip'), width: 82,
      render: (r) => (r.rosterAdj
        ? <span className={signClass(r.rosterAdj)}>{signed(r.rosterAdj, 2)}</span>
        : <span className="dim">—</span>),
    },
    { key: "offRtg", label: <Th abbr="ORtg" label={t('dashboard.col.ortg')} />, title: t('dashboard.col.ortgTip'), width: 64, render: (r) => num(r.offRtg) },
    { key: "defRtg", label: <Th abbr="DRtg" label={t('dashboard.col.drtg')} />, title: t('dashboard.col.drtgTip'), width: 64, render: (r) => num(r.defRtg) },
    { key: "pace", label: <Th abbr="PACE" label={t('dashboard.col.pace')} />, title: t('dashboard.col.paceTip'), width: 64, render: (r) => num(r.pace) },
    {
      key: 'record', label: t('dashboard.col.record', { season: meta.displayCurrent ? meta.targetSeason : meta.priorSeason }), width: 90,
      render: (r) => <span className="mono dim">{r.record ?? r.priorRecord}</span>,
    },
  ];

  return (
    <>
      <div className="page-head">
        <h1>{t('dashboard.title', { season: meta.targetSeason })}</h1>
        <p>
          {rosterMode ? t('dashboard.introRoster') : t('dashboard.introElo', { season: meta.priorSeason })}
        </p>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <LeaderTile label={rosterMode ? t('dashboard.leader.roster') : t('dashboard.leader.top')} row={validRankings[0]} teamById={teamById} fmt={fmt} t={t} />
        <LeaderTile label={t('dashboard.leader.east')} row={east[0]} teamById={teamById} fmt={fmt} t={t} />
        <LeaderTile label={t('dashboard.leader.west')} row={west[0]} teamById={teamById} fmt={fmt} t={t} />
        <LeaderTile label={rosterMode ? t('dashboard.leader.upgraded') : t('dashboard.leader.improved')} row={mostImproved} teamById={teamById} field={improvementField} fmt={fmt} t={t} />
      </div>

      <div className="card">
        <h2>
          {t('dashboard.board')}
          <span className="sub">{rosterMode ? t('dashboard.boardRoster', { k: rankings[0]?.rosterProjection?.results?.k ?? '—' }) : t('dashboard.boardElo')}</span>
          <span style={{ marginLeft: 'auto' }}>
            <Segmented
              value={groupBy}
              onChange={setGroupBy}
              options={[
                { value: 'conference', label: t('dashboard.group.conf') },
                { value: 'division', label: t('dashboard.group.div') },
                { value: 'league', label: t('dashboard.group.league') },
              ]}
            />
          </span>
        </h2>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <Segmented value={rankingModel} onChange={setRankingModel} options={[
            { value: 'roster', label: t('dashboard.model.roster') }, { value: 'elo', label: t('dashboard.model.elo') },
          ]} />
          {rosterMode && <Segmented value={availability} onChange={setAvailability} options={[
            { value: 'reported', label: t('dashboard.avail.reported') }, { value: 'healthy', label: t('dashboard.avail.healthy') },
          ]} />}
        </div>
        {rosterMode && rosterNotices.length > 0 && <p className="note neg" style={{ marginBottom: 8 }}>{rosterNotices.join(' ')}</p>}
        {rosterMode && <p className="note" style={{ marginBottom: 14 }}>
          {t('dashboard.note.formula', { k: rp?.results?.k ?? '—' })}<br />
          {t('dashboard.note.prior')}<br />
          {t('dashboard.note.backtest')}<b>{t('dashboard.note.eloBold')}</b>{t('dashboard.note.eloAfter')}
          {t('dashboard.note.times', {
            stats: meta.statsFetchedAt ?? meta.fetchedAt,
            inj: rp?.injuryFetchedAt ?? t('dashboard.note.unknown'),
            age: injuryAge != null ? t('dashboard.note.hoursAgo', { count: Math.round(injuryAge) }) : '',
          })}
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
          groupsOf(rankings, groupBy).map(([gkey, rows]) => {
            const label = groupBy === 'conference' ? fmt.conf(gkey) : fmt.div(gkey);
            return (
            <div key={gkey} style={{ marginBottom: 16 }}>
              <div className="group-head">
                {label}
                <span>{t('dashboard.groupSummary', { count: rows.length, team: fmt.teamName(teamById.get(rows[0].teamId)), score: signed(rows[0].total, 1) })}</span>
              </div>
              <DataTable
                key={`${rankingModel}-${availability}-${gkey}`}
                columns={cols}
                rows={rows}
                initialSort={{ key: 'total', dir: 'desc' }}
                rowKey={(r) => r.teamId}
                onRowClick={selectTeam}
              />
            </div>
            );
          })
        )}
      </div>

      {detail && <div className="card">
        <h2>{t('dashboard.detail.title', { team: fmt.teamName(teamById.get(detail.teamId)) })}
          <span className="sub">{t('dashboard.detail.sub', { total: signed(detail.total, 2), prior: signed(detail.priorTotal, 2), adj: signed(detail.resultsAdj, 2), legacy: signed(detail.legacyTotal, 2) })}</span>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => go(`team/${detail.teamId}`)}>{t('dashboard.detail.teamPage')}</button>
        </h2>
        {detail.rosterProjection.error ? <p className="note">{t(detail.rosterProjection.errorCode ?? 'srv.roster.insufficient')}</p> : <>
          {detail.rosterProjection.results && <p className="note">{t('dashboard.detail.results', {
            games: detail.rosterProjection.results.games,
            eff: num(detail.rosterProjection.results.effectiveGames, 1),
            adj: detail.rosterProjection.results.adjResult == null ? '—' : signed(detail.rosterProjection.results.adjResult, 2),
            priorW: num(detail.rosterProjection.results.priorWeight * 100, 0),
            k: detail.rosterProjection.results.k,
            resW: num((1 - detail.rosterProjection.results.priorWeight) * 100, 0),
          })}</p>}
          <p className="note">{t('dashboard.detail.sources', {
            list: Object.entries(detail.rosterProjection.impactSourceShares ?? {})
              .map(([k, v]) => `${tOr(`dashboard.impactSource.${k}`, k)} ${num(v * 100, 0)}%`).join(t('dashboard.listSep')),
          })}</p>
          <p className="note">{t(availability === 'reported' ? 'dashboard.detail.minutesReported' : 'dashboard.detail.minutesManual', {
            repl: num(detail.rosterProjection.replacementMinutes ?? 0, 1),
          })}</p>
          <DataTable rows={detail.rosterProjection.rotation} rowKey={(p) => p.playerId}
            initialSort={{ key: 'minutes', dir: 'desc' }} maxHeight={360} columns={[
              { key: 'name', label: t('dashboard.rot.player'), align: 'left' },
              { key: 'minutes', label: t('dashboard.rot.minutes'), render: (p) => num(p.minutes, 1) },
              { key: 'play', label: t('dashboard.rot.play'), title: t('dashboard.rot.playTip'), value: (p) => p.availability * (p.rotation ?? 1),
                render: (p) => {
                  const st = p.injuryStatus ? tOr(`dashboard.status.${p.injuryStatus}`, p.injuryStatus) : null;
                  return <span className="dim" title={st ?? undefined}>
                    {num(p.availability * (p.rotation ?? 1) * 100, 0)}%{st ? t('dashboard.rot.statusSuffix', { status: st }) : ''}</span>;
                } },
              { key: 'impact', label: 'IMP', render: (p) => {
                const src = rosterSourceMsg(p);
                return <span title={src ? renderMsg(src, t) : undefined}>{signed(p.impact, 2)}{p.fromPrior ? t('dashboard.rot.estimated') : ''}</span>;
              } },
              { key: 'contribution', label: t('dashboard.rot.contribution'), value: (p) => p.impact * p.minutes / 48,
                render: (p) => signed(p.impact * p.minutes / 48, 2) },
              { key: 'minutesSource', label: t('dashboard.rot.minutesSource'), render: (p) => p.availability === 0 ? t('dashboard.rot.outManual')
                : tOr(`dashboard.minutesSource.${p.minutesSource}`, t('dashboard.minutesSource.other')) },
            ]} />
        </>}
      </div>}

      {dayGames.length > 0 && (
        <div className="card">
          <h2>
            {nextDay === tzToday(tz) ? t('dashboard.next.today') : t('dashboard.next.day')}
            <span className="sub">{fmt.date(nextDay)} · {fmt.zoneLabel()} · {t('dashboard.next.sub', { count: dayGames.length })}</span>
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => go(`today/${nextDay}`)}>
              {t('dashboard.next.all')}
            </button>
          </h2>
          <div className="grid cols-3">
            {dayGames.slice(0, 6).map((g) => <GameCard key={g.gameId} game={g} teamById={teamById} fmt={fmt} t={t} />)}
          </div>
        </div>
      )}

      <div className="card plain">
        <h2>{rosterMode ? t('dashboard.desc.titleLegacy') : t('dashboard.desc.title')}</h2>
        <p className="note">
          <b>{t('dashboard.desc.rtgB')}</b>{t('dashboard.desc.rtg', { wElo: num(meta.defaultParams.wElo, 2), wNet: num(meta.defaultParams.wNet, 2) })}<br />
          <b>Elo</b>{t('dashboard.desc.elo', { n: meta.gamesPlayedCurrent ?? 0 })}<br />
          <b>{t('dashboard.desc.impactB')}</b>{t('dashboard.desc.impact', { r2: meta.impactFit.r2.toFixed(3) })}<br />
          <b>{t('dashboard.desc.turnoverB')}</b>{t('dashboard.desc.turnover', { w: num(meta.defaultParams.turnoverWeight, 2) })}<br />
          <b>{t('dashboard.desc.outB')}</b>{t('dashboard.desc.out')}<br />
          <b>{t('dashboard.desc.healthyB')}</b>{t('dashboard.desc.healthy')}<br />
          <b>{t('dashboard.desc.winB')}</b>{t('dashboard.desc.win', { sd: num(meta.defaultParams.spreadSd) })}
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
  // 分组键用原始代码（East / Atlantic…），显示名由调用方按语言给出
  const keyOf = (t) => (mode === 'conference' ? t.conference : t.division);
  const order = mode === 'conference' ? ['East', 'West'] : DIV_CODES;

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
function LeaderTile({ label, row, teamById, fmt, t, field = 'total' }) {
  if (!row) return null;
  const team = teamById.get(row.teamId);
  return (
    <div className="tile" style={{ cursor: 'pointer' }} onClick={() => go(`team/${row.teamId}`)}>
      <div className="k">{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 7 }}>
        <TeamLogo team={team} size={34} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 720, fontSize: 15, letterSpacing: '-.2px' }}>{fmt.teamName(team)}</div>
          <div className={`mono ${signClass(row[field])}`} style={{ fontSize: 12, fontWeight: 700 }}>
            {signed(row[field], 2)} {t('dashboard.perGame')}
          </div>
        </div>
      </div>
    </div>
  );
}

function GameCard({ game, teamById, fmt, t }) {
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
        <span>{t('common.tipoff', { time: fmt.timeZoned(game.dateTimeUtc) })}</span>
        <span>{game.national?.join(' / ') || game.arena}</span>
      </div>
      <Side team={away} score={p.awayScore} bold={!homeFav} fmt={fmt} />
      <div style={{ height: 6 }} />
      <Side team={home} score={p.homeScore} bold={homeFav} fmt={fmt} />
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

function Side({ team, score, bold, fmt }) {
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
        {fmt.teamName(team)}
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
