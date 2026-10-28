import React, { useEffect, useMemo, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api, withOut } from '../lib/api.js';
import {
  TeamLogo, TeamCell, PlayerHeadshot, StatTile, DataTable, InjuryBadge,
  Loading, ErrorBox, Segmented, ProbBar, Th,
} from '../components/common.jsx';
import PlayerTable, { modeOptions } from '../components/PlayerTable.jsx';
import {
  num, rate, signed, signClass, probColor, monthOf,
} from '../lib/format.js';
import { useI18n } from '../i18n/react.jsx';

export default function TeamDetail({ teamId }) {
  const { meta, teamById, out, toggleOut, params, setAccent } = useApp();
  const { t, fmt, lang } = useI18n();
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
  const tm = data.team;
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
        <TeamLogo team={tm} size={62} />
        <div>
          <h1>{fmt.teamName(tm)}</h1>
          <div className="en">
            {t('teamDetail.sub', {
              name: lang === 'zh' ? tm.full : tm.abbr,
              conf: fmt.conf(tm.conference),
              div: fmt.div(tm.division),
              season: meta.displayCurrent ? meta.targetSeason : meta.priorSeason,
              w: tm.wins,
              l: tm.losses,
              rank: tm.confRank,
            })}
          </div>
        </div>
        <div className="right">
          <b className={signClass(ranking.total)}>{signed(ranking.total, 2)}</b>
          <span>{t('teamDetail.rating', { rank: ranking.rank })}</span>
        </div>
        <button className="btn" style={{ marginLeft: 14 }} onClick={() => go('teams')}>{t('teamDetail.back')}</button>
      </div>

      <div className="grid cols-5" style={{ marginBottom: 14 }}>
        <StatTile abbr="ORtg" label={t('teamDetail.tile.ortg')} value={num(tm.adv.offRtg)} hint={t('teamDetail.tile.ortgHint')} />
        <StatTile abbr="DRtg" label={t('teamDetail.tile.drtg')} value={num(tm.adv.defRtg)} hint={t('teamDetail.tile.drtgHint')} />
        <StatTile abbr="NetRtg" label={t('teamDetail.tile.net')} value={signed(tm.adv.netRtg)} />
        <StatTile abbr="PACE" label={t('teamDetail.tile.pace')} value={num(tm.adv.pace)} hint={t('teamDetail.tile.paceHint')} />
        <StatTile
          label={t('teamDetail.tile.projWins', { season: meta.targetSeason })}
          value={projWins.toFixed(1)}
          unit={` / ${regular.length}`}
        />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>{t('teamDetail.stats')} <span className="sub">{t('teamDetail.perGame', { season: meta.displayCurrent ? meta.targetSeason : meta.priorSeason })}</span></h2>
          <div className="grid cols-3">
            <StatTile abbr="PTS" label={t('teamDetail.stat.pts')} value={num(tm.base.pts)} />
            <StatTile abbr="REB" label={t('teamDetail.stat.reb')} value={num(tm.base.reb)} />
            <StatTile abbr="AST" label={t('teamDetail.stat.ast')} value={num(tm.base.ast)} />
            <StatTile abbr="FG%" label={t('teamDetail.stat.fg')} value={rate(tm.base.fgPct)} />
            <StatTile abbr="3P%" label={t('teamDetail.stat.fg3')} value={rate(tm.base.fg3Pct)} />
            <StatTile abbr="FT%" label={t('teamDetail.stat.ft')} value={rate(tm.base.ftPct)} />
            <StatTile abbr="TS%" label={t('teamDetail.stat.ts')} value={rate(tm.adv.tsPct)} />
            <StatTile abbr="AST%" label={t('teamDetail.stat.astPct')} value={rate(tm.adv.astPct)} />
            <StatTile abbr="3PA%" label={t('teamDetail.stat.pct3')} value={rate(tm.scoring.pct3pt)} />
          </div>
        </div>

        <div className="card">
          <h2>{t('teamDetail.ff.title')} <span className="sub">{t('teamDetail.ff.sub')}</span></h2>
          <FourFactors ff={tm.fourFactors} />
          <div className="divider" />
          <h2>{t('teamDetail.profile')}</h2>
          <div className="grid cols-3">
            <StatTile label={t('teamDetail.homeGames')} value={homeGames} />
            <StatTile abbr="B2B" label={t('teamDetail.b2b')} value={b2b} />
            <StatTile abbr="ΔROS" label={t('teamDetail.turnover')} value={signed(ranking.turnoverAdj, 2)} hint={t('teamDetail.turnoverHint')} />
          </div>
        </div>
      </div>

      <div className="card">
        <h2>
          {t('teamDetail.roster')}
          <span className="sub">{t('teamDetail.rosterSub', { count: roster.length })}</span>
          <span style={{ marginLeft: 'auto' }}>
            <Segmented
              value={statMode}
              onChange={setStatMode}
              options={modeOptions(t)}
            />
          </span>
        </h2>
        {outIds.length > 0 && (
          <div className="notice">
            {t('teamDetail.outNotice', { count: outIds.length, adj: signed(ranking.rosterAdj, 2) })}
          </div>
        )}
        <PlayerTable
          rows={roster}
          mode={statMode}
          nameColumn={{
            key: 'name', label: t('teamDetail.col.player'), align: 'left', width: 226,
            render: (p) => (
              <span className="player-row">
                <input
                  type="checkbox"
                  title={t('teamDetail.markOut')}
                  checked={outIds.includes(p.playerId)}
                  onChange={() => toggleOut(teamId, p.playerId)}
                  onClick={(e) => e.stopPropagation()}
                />
                <PlayerHeadshot player={p} size={28} />
                <span style={{ opacity: outIds.includes(p.playerId) ? 0.42 : 1 }}>
                  {p.name}
                  <InjuryBadge injury={p.injury} />
                  {p.noPriorData && !meta.displayCurrent && <span className="chip" style={{ marginLeft: 6 }}>{t('teamDetail.noPrior')}</span>}
                </span>
              </span>
            ),
          }}
          extraColumns={[
            { key: 'number', label: t('teamDetail.col.number'), width: 36, render: (p) => <span className="dim">{p.number}</span> },
            { key: 'posCn', label: t('teamDetail.col.pos'), width: 72, align: 'left', render: (p) => <span className="dim">{p.pos ? fmt.pos(p.pos) : '—'}</span> },
            { key: 'age', label: t('teamDetail.col.age'), width: 44, render: (p) => num(p.age, 0) },
          ]}
        />
      </div>

      <div className="card">
        <h2>
          {t('teamDetail.turnover')}
          <span className="sub">
            {t('teamDetail.moves', { inN: arrivals.length, outN: departures.length, adj: signed(ranking.turnoverAdj, 2) })}
          </span>
        </h2>
        <div className="grid cols-2">
          <MoveList title={t('teamDetail.in')} tone="pos" rows={arrivals} teamById={teamById} from />
          <MoveList title={t('teamDetail.out')} tone="neg" rows={departures} teamById={teamById} />
        </div>
        <p className="note" style={{ marginTop: 10 }}>
          {t('teamDetail.moveNote')}
        </p>
      </div>

      <div className="card">
        <h2>
          {t('teamDetail.schedule', { season: meta.targetSeason })}
          <span className="sub">{games.length}{t('common.unit.games', { count: games.length })}</span>
          <span style={{ marginLeft: 'auto' }}>
            <select value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="all">{t('teamDetail.allMonths')}</option>
              {months.map((m) => <option key={m} value={m}>{fmt.month(m)}</option>)}
            </select>
          </span>
        </h2>
        <TeamSchedule games={games} teamId={teamId} teamById={teamById} />
        <p className="note" style={{ marginTop: 10 }}>
          {t('teamDetail.scheduleNote', { home: homeGames, b2b })}
        </p>
      </div>
    </>
  );
}

function FourFactors({ ff }) {
  const { t } = useI18n();
  const rows = [
    { i: 1, abbr: "eFG%", label: t('teamDetail.ff.efg'), own: ff.efgPct, opp: ff.oppEfgPct, better: 'high' },
    { i: 2, abbr: "TOV%", label: t('teamDetail.ff.tov'), own: ff.tovPct, opp: ff.oppTovPct, better: 'low' },
    { i: 3, abbr: "OREB%", label: t('teamDetail.ff.oreb'), own: ff.orebPct, opp: ff.oppOrebPct, better: 'high' },
    { i: 4, abbr: "FTr", label: t('teamDetail.ff.ftr'), own: ff.ftaRate, opp: ff.oppFtaRate, better: 'high' },
  ];
  return (
    <DataTable
      columns={[
        // 按四要素的公认权重顺序固定排列，而不是按中文名排序
        {
          key: "label", label: t('teamDetail.ff.factor'), align: "left", width: 138, value: (r) => r.i,
          render: (r) => <span className="row-label"><b>{r.abbr}</b><i>{r.label}</i></span>,
        },
        { key: "own", label: <Th abbr="TM" label={t('teamDetail.ff.team')} />, title: t('teamDetail.ff.team'), width: 66, render: (r) => `${rate(r.own)}%` },
        { key: "opp", label: <Th abbr="OPP" label={t('teamDetail.ff.opp')} />, title: t('teamDetail.ff.opp'), width: 66, render: (r) => `${rate(r.opp)}%` },
        {
          key: 'diff', label: t('teamDetail.ff.edge'), width: 66,
          value: (r) => (r.better === 'high' ? r.own - r.opp : r.opp - r.own),
          render: (r) => {
            const d = (r.better === 'high' ? r.own - r.opp : r.opp - r.own) * 100;
            return <span className={signClass(d)}>{signed(d, 1)}</span>;
          },
        },
      ]}
      rows={rows}
      initialSort={{ key: 'label', dir: 'asc' }}
      rowKey={(r) => r.abbr}
    />
  );
}

/** 转入/转出名单 */
function MoveList({ title, tone, rows, teamById, from }) {
  const { t } = useI18n();
  if (!rows.length) {
    return <div><b className={tone} style={{ fontSize: 12.5 }}>{title}</b><div className="empty">{t('teamDetail.none')}</div></div>;
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
                      ? <span className="chip">{t('teamDetail.rookie')}</span>
                      : other
                        ? <span className="team-cell"><TeamLogo team={other} size={17} />{from ? t('teamDetail.fromTeam') : t('teamDetail.toTeam')}</span>
                        : (from ? t('teamDetail.freeAgent') : t('teamDetail.leftLeague'))}
                  </td>
                  <td className="dim" style={{ width: 74, fontSize: 11 }}>
                    {p.gp ? t('teamDetail.gpMin', { gp: p.gp, min: num(p.min) }) : '—'}
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
  const { t, fmt } = useI18n();
  return (
    <DataTable
      maxHeight={560}
      rows={games}
      rowKey={(g) => g.gameId}
      initialSort={{ key: 'date', dir: 'asc' }}
      onRowClick={(g) => go(`predict/${g.awayId}/${g.homeId}/${g.gameId}`)}
      columns={[
        {
          key: 'date', label: t('teamDetail.sch.date'), align: 'left', width: 110,
          render: (g) => <span className="dim">{fmt.date(g.date)}</span>,
        },
        {
          key: 'opp', label: t('teamDetail.sch.opp'), align: 'left', width: 206,
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
          key: 'rest', label: t('teamDetail.sch.rest'), width: 62,
          value: (g) => (g.homeId === teamId ? g.prediction.restHome : g.prediction.restAway),
          render: (g) => {
            const r = g.homeId === teamId ? g.prediction.restHome : g.prediction.restAway;
            return <span className={r === 0 ? 'neg' : 'dim'}>{fmt.rest(r)}</span>;
          },
        },
        {
          key: 'win', label: t('teamDetail.sch.win'), width: 116,
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
          key: 'score', label: t('teamDetail.sch.score'), width: 132,
          value: (g) => (g.homeId === teamId ? g.prediction.margin : -g.prediction.margin),
          render: (g) => {
            const pOwn = g.homeId === teamId ? g.prediction.homeScore : g.prediction.awayScore;
            const pOpp = g.homeId === teamId ? g.prediction.awayScore : g.prediction.homeScore;
            const predicted = <span className="dim">{t('teamDetail.sch.pred', { own: pOwn.toFixed(0), opp: pOpp.toFixed(0) })}</span>;
            if (g.homeScore == null) return <span className="mono">{predicted}</span>;
            // 已结束：真实比分 + 赛前预测，以及预测的胜方猜没猜对
            const own = g.homeId === teamId ? g.homeScore : g.awayScore;
            const opp = g.homeId === teamId ? g.awayScore : g.homeScore;
            return (
              <span className="mono">
                <b className={own > opp ? 'pos' : 'neg'}>{own > opp ? t('teamDetail.sch.w') : t('teamDetail.sch.l')}</b> {own}-{opp}
                <br />{predicted}{' '}
                <span className={`chip ${g.hit ? 'hit' : 'miss'}`}>{g.hit ? '✓' : '✗'}</span>
              </span>
            );
          },
        },
        {
          key: 'label', label: t('teamDetail.sch.note'), align: 'left', width: 152,
          render: (g) => (g.label
            ? <span className="chip blue">{g.label}</span>
            : <span className="dim">{g.national?.join('/') || ''}</span>),
        },
      ]}
    />
  );
}
