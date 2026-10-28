import React, { useEffect, useMemo, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api, withOut } from '../lib/api.js';
import { TeamCell, Loading, ErrorBox, ProbBar, StatTile } from '../components/common.jsx';
import { useI18n } from '../i18n/react.jsx';
import { groupByDay } from '../lib/gameDays.js';
import { probColor, num } from '../lib/format.js';

const TYPES = ['regular', 'preseason', 'all'];

export default function Schedule() {
  const { meta, teams, teamById, out, params, setAccent } = useApp();
  const { tz, t, fmt } = useI18n();
  const [type, setType] = useState('regular');
  const [teamFilter, setTeamFilter] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState({ loading: true });

  // 筛选到某支球队时整站配色跟着走
  useEffect(() => {
    setAccent(teamFilter === 'all' ? null : teamById.get(Number(teamFilter)) ?? null);
    return () => setAccent(null);
  }, [teamFilter, teamById, setAccent]);

  useEffect(() => {
    let alive = true;
    setData((d) => ({ ...d, loading: true }));
    api.schedule(withOut({
      ...params,
      type,
      teamId: teamFilter === 'all' ? undefined : teamFilter,
      from: from || undefined,
      to: to || undefined,
    }, out))
      .then((d) => alive && setData({ loading: false, ...d }))
      .catch((error) => alive && setData({ loading: false, error }));
    return () => { alive = false; };
  }, [type, teamFilter, from, to, params, out]);

  // 盘口是快照，页面上要说清它有多旧——用户看到一条三周前的线却以为是当前的，
  // 比看不到盘口更容易被误导
  const withOdds = useMemo(() => (data.games ?? []).filter((g) => g.market), [data.games]);
  const oddsCount = withOdds.length;
  const oddsAge = oddsCount ? fmt.snapshotAge(withOdds[0].market.fetchedAt) : null;

  const byDate = useMemo(() => {
    if (!data.games) return [];
    return groupByDay(data.games, tz);
  }, [data.games, tz]);

  if (data.error) return <ErrorBox error={data.error} />;

  const games = data.games ?? [];
  const dateRange = byDate.length ? `${byDate[0][0]} ~ ${byDate[byDate.length - 1][0]}` : '—';
  const closeGames = games.filter((g) => Math.abs(g.prediction.homeWinProb - 0.5) < 0.06).length;
  const finished = games.filter((g) => g.hit !== undefined);
  const hits = finished.filter((g) => g.hit).length;

  return (
    <>
      <div className="page-head">
        <h1>{t('schedule.title', { season: meta.targetSeason })}</h1>
        <p>{t('schedule.intro')}</p>
      </div>

      <div className="toolbar">
        <div className="field">
          <label>{t('schedule.filter.type')}</label>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((v) => <option key={v} value={v}>{t(`schedule.type.${v}`)}</option>)}
          </select>
        </div>
        <div className="field">
          <label>{t('schedule.filter.team')}</label>
          <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} style={{ minWidth: 150 }}>
            <option value="all">{t('schedule.filter.allTeams')}</option>
            {fmt.sortTeams(teams).map((tm) => (
              <option key={tm.teamId} value={tm.teamId}>{fmt.teamName(tm)}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>{t('schedule.filter.from')}</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label>{t('schedule.filter.to')}</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <button className="btn" onClick={() => { setFrom(''); setTo(''); setTeamFilter('all'); }}>{t('schedule.filter.reset')}</button>
        </div>
      </div>

      <div className="grid cols-5" style={{ marginBottom: 14 }}>
        <StatTile label={t('schedule.tile.games')} value={games.length} unit={t('common.unit.games', { count: games.length })} />
        <StatTile
          label={t('schedule.tile.hitRate')}
          value={finished.length ? fmt.pct(hits / finished.length, 1) : '—'}
          hint={finished.length ? t('schedule.tile.hitHint', { n: finished.length, hits }) : t('schedule.tile.noneFinished')}
        />
        <StatTile label={t('schedule.tile.days')} value={byDate.length} unit={t('common.unit.days', { count: byDate.length })} />
        <StatTile label={t('schedule.tile.range')} value={dateRange} hint={fmt.zoneLabel()} />
        <StatTile label={t('schedule.tile.close')} value={closeGames} unit={t('common.unit.games', { count: closeGames })} hint={t('schedule.tile.closeHint')} />
      </div>

      {data.loading ? <Loading /> : (
        <div className="card">
          <h2>
            {t('schedule.list')}
            <span className="sub">
              {t('schedule.listNote')}
              {oddsAge && t('schedule.oddsNote', { count: oddsCount, age: oddsAge.text })}
            </span>
          </h2>
          {oddsAge?.stale && (
            <div className="market-stale" style={{ marginBottom: 10 }}>
              {t('schedule.oddsStale', { days: oddsAge.days })}
            </div>
          )}
          <div className="table-wrap" style={{ maxHeight: 700, overflowY: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th className="left" style={{ width: 112 }}>{t('schedule.col.date')} <span className="dim" style={{ fontWeight: 400 }}>{fmt.zoneLabel()}</span></th>
                  <th className="left" style={{ width: 184 }}>{t('schedule.col.away')}</th>
                  <th className="left" style={{ width: 184 }}>{t('schedule.col.home')}</th>
                  <th style={{ width: 58 }}>{t('schedule.col.rest')}</th>
                  <th style={{ width: 122 }}>{t('schedule.col.homeProb')}</th>
                  <th style={{ width: 84 }}>{t('schedule.col.predScore')}</th>
                  <th style={{ width: 118 }} title={t('schedule.col.actualTip')}>{t('schedule.col.actual')}</th>
                  <th style={{ width: 62 }}>{t('schedule.col.total')}</th>
                  <th style={{ width: 96 }} title={t('schedule.col.lineTip')}>{t('schedule.col.line')}</th>
                  <th className="left" style={{ width: 170 }}>{t('schedule.col.venue')}</th>
                </tr>
              </thead>
              <tbody>
                {byDate.map(([date, list]) => list.map((g, i) => (
                  <tr
                    key={g.gameId}
                    className="clickable"
                    onClick={() => go(`predict/${g.awayId}/${g.homeId}/${g.gameId}`)}
                  >
                    <td className="left sched-date">{i === 0 ? fmt.date(date) : ''}</td>
                    <td className="left"><TeamCell team={teamById.get(g.awayId)} size={20} showAbbr={false} /></td>
                    <td className="left"><TeamCell team={teamById.get(g.homeId)} size={20} showAbbr={false} /></td>
                    <td className="dim" style={{ fontSize: 10.5 }}>
                      {fmt.rest(g.prediction.restAway)}<br />{fmt.rest(g.prediction.restHome)}
                    </td>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                        <ProbBar p={g.prediction.homeWinProb} width={52} />
                        <b className="mono" style={{ color: probColor(g.prediction.homeWinProb) }}>
                          {(g.prediction.homeWinProb * 100).toFixed(0)}%
                        </b>
                      </span>
                    </td>
                    <td className={g.homeScore != null ? 'mono dim' : 'mono'}>
                      {g.prediction.awayScore.toFixed(0)} - {g.prediction.homeScore.toFixed(0)}
                    </td>
                    <td className="mono">
                      {g.homeScore != null ? (
                        <>
                          <b>{g.awayScore} - {g.homeScore}</b>{' '}
                          <span className={`chip ${g.hit ? 'hit' : 'miss'}`}>{g.hit ? t('schedule.hit') : t('schedule.miss')}</span>
                        </>
                      ) : <span className="dim">—</span>}
                    </td>
                    <td className="mono dim">{num(g.prediction.total, 0)}</td>
                    <td className="mono" style={{ fontSize: 10.5 }}>
                      {g.market ? (
                        <>
                          {g.market.spread > 0 ? `+${g.market.spread}` : g.market.spread}
                          <br />
                          <span className={Math.abs(g.market.edge) >= 3 ? 'pos' : 'dim'}>
                            {g.market.edge > 0 ? `+${g.market.edge}` : g.market.edge}
                          </span>
                        </>
                      ) : <span className="dim">—</span>}
                    </td>
                    <td className="left dim" style={{ fontSize: 10.5 }}>
                      {g.label ? <span className="chip blue">{g.label}</span> : g.arena}
                    </td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
          {games.length === 0 && <div className="empty">{t('schedule.empty')}</div>}
        </div>
      )}
    </>
  );
}
