import React, { useEffect, useMemo, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api, withOut } from '../lib/api.js';
import { TeamLogo, Loading, ErrorBox, ProbBar, StatTile } from '../components/common.jsx';
import { useI18n } from '../i18n/react.jsx';
import { tzToday } from '../i18n/fmt.js';
import { gameDates, gamesOn, fetchRangeFor } from '../lib/gameDays.js';
import { probColor } from '../lib/format.js';

/**
 * 今日比赛：按所选时区（默认随语言：中文北京、英文美东）取一天的比赛，逐场给出模型预测。
 *
 * 两个容易说错的地方，界面上都要讲清楚：
 *   1. 数据是快照。评级、伤病、盘口都停在最后一次抓取的时刻，
 *      今天打完的比赛要等下次刷新才有比分。
 *   2. 已结束比赛的预测是用**赛前评级**重算的（服务端换回开打前的 Elo）。
 *      当前评级已经吸收了这场的结果，直接拿它判断对错是事后诸葛亮。
 *      名单和参数还是现在的，所以这是「用赛前评级重算」，不是当时存档的预测。
 */
export default function Today({ initial = [] }) {
  const { meta, teamById, injuries, out, params, setAccent } = useApp();
  const { tz, t, fmt } = useI18n();
  const [dates, setDates] = useState(null);
  const [allGames, setAllGames] = useState(null);
  const [date, setDate] = useState(initial[0] || null);
  const [data, setData] = useState({ loading: true });

  useEffect(() => { setAccent(null); }, [setAccent]);

  // 日期写在地址里（#/today/2026-10-28），可以分享，浏览器前进后退也跟着走
  const routeDate = initial[0] || null;
  useEffect(() => { if (routeDate) setDate(routeDate); }, [routeDate]);

  // 全赛程（不预测）只取一次；有比赛的日期随所选时区重算，用来定默认日期和前后翻页
  useEffect(() => {
    let alive = true;
    api.schedule({ type: 'all', predict: '0' })
      .then((d) => alive && setAllGames(d.games))
      .catch((error) => alive && setData({ loading: false, error }));
    return () => { alive = false; };
  }, []);
  useEffect(() => { if (allGames) setDates(gameDates(allGames, tz)); }, [allGames, tz]);

  // 没指定日期：今天有比赛就是今天，否则下一个比赛日（休赛期则是最后一个）
  useEffect(() => {
    if (date || !dates?.length) return;
    const today = tzToday(tz);
    setDate(dates.find((d) => d >= today) ?? dates[dates.length - 1]);
  }, [dates, date, tz]);

  useEffect(() => {
    if (!date) return undefined;
    let alive = true;
    setData((d) => ({ ...d, loading: true }));
    // 服务端 from/to 是美东日期；任一时区的某天都落在前后各一天内，取回后再按所选时区精确过滤
    // （请求里不带 tz / lang：时区只影响分日与显示，不改预测）
    api.schedule(withOut({ ...params, type: 'all', ...fetchRangeFor(date) }, out))
      .then((d) => {
        if (!alive) return;
        setData({ loading: false, games: gamesOn(d.games, date, tz) });
      })
      .catch((error) => alive && setData({ loading: false, error }));
    return () => { alive = false; };
  }, [date, params, out, tz]);

  const outByTeam = useMemo(() => {
    const m = new Map();
    for (const i of injuries.players ?? []) {
      if (!m.has(i.teamId)) m.set(i.teamId, []);
      m.get(i.teamId).push(i);
    }
    return m;
  }, [injuries]);

  if (data.error) return <ErrorBox error={data.error} />;

  const idx = dates && date ? dates.indexOf(date) : -1;
  const prev = idx > 0 ? dates[idx - 1] : null;
  const next = idx >= 0 && idx < dates.length - 1 ? dates[idx + 1] : null;
  const pick = (d) => go(`today/${d}`);

  const games = data.games ?? [];
  const upcoming = games.filter((g) => g.homeScore == null);
  const sure = [...upcoming].sort((a, b) => conf(b) - conf(a))[0];
  const close = [...upcoming].sort((a, b) => conf(a) - conf(b))[0];
  const split = upcoming.filter((g) => g.market).sort((a, b) => Math.abs(b.market.edge) - Math.abs(a.market.edge))[0];
  const age = fmt.snapshotAge(meta.fetchedAt, { staleDays: 1 });
  const isToday = date === tzToday(tz);
  // 当天比赛全打完了：赛前指标没有对象，换成这一天的预测复盘
  const finished = games.filter((g) => g.hit !== undefined);
  const review = finished.length > 0 && upcoming.length === 0;
  const hits = finished.filter((g) => g.hit).length;
  // 最大冷门：赢球一方的赛前胜率最低的那场
  const winProb = (g) => (g.homeScore > g.awayScore ? g.prediction.homeWinProb : 1 - g.prediction.homeWinProb);
  const upset = [...finished].sort((a, b) => winProb(a) - winProb(b))[0];
  // 比分预测最准：预测分差与实际分差最接近
  const marginErr = (g) => Math.abs(g.prediction.margin - (g.homeScore - g.awayScore));
  const sharpest = [...finished].sort((a, b) => marginErr(a) - marginErr(b))[0];
  const matchup = (g) => `${teamById.get(g.awayId)?.abbr} @ ${teamById.get(g.homeId)?.abbr}`;

  return (
    <>
      <div className="page-head">
        <h1>{isToday ? t('today.titleToday') : t('today.titleDay')}</h1>
        <p>{t('today.intro', { zone: fmt.zoneLabel() })}</p>
      </div>

      <div className="toolbar">
        <button className="btn" disabled={!prev} onClick={() => prev && pick(prev)}>{t('today.prevDay')}</button>
        <div className="field" style={{ minWidth: 0 }}>
          <b style={{ fontSize: 15 }}>{date ? fmt.date(date) : '—'}</b>
          <span className="dim" style={{ marginLeft: 8 }}>{isToday ? t('today.zoneToday', { zone: fmt.zoneLabel() }) : fmt.zoneLabel()}</span>
        </div>
        <button className="btn" disabled={!next} onClick={() => next && pick(next)}>{t('today.nextDay')}</button>
        {!isToday && dates?.length > 0 && (
          <button className="btn" onClick={() => pick(dates.find((d) => d >= tzToday(tz)) ?? dates[dates.length - 1])}>
            {t('today.backToToday')}
          </button>
        )}
      </div>

      {age && (
        <div className={age.stale ? 'market-stale' : 'note'} style={{ marginBottom: 12 }}>
          {t('today.snapshot', { date: meta.lastResultDate ?? '—', age: age.text })}
        </div>
      )}

      {review ? (
        <div className="grid cols-4" style={{ marginBottom: 14 }}>
          <StatTile label={t('today.tile.games')} value={games.length} unit={t('common.unit.games', { count: games.length })} hint={t('today.tile.allFinished')} />
          <StatTile label={t('today.tile.picksRight')} value={`${hits} / ${finished.length}`}
            hint={t('today.tile.hitRate', { rate: hits / finished.length })} />
          <StatTile label={t('today.tile.upset')} value={matchup(upset)}
            hint={t('today.tile.upsetHint', { p: winProb(upset) })} />
          <StatTile label={t('today.tile.sharpest')} value={matchup(sharpest)}
            hint={t('today.tile.sharpestHint', { n: marginErr(sharpest) })} />
        </div>
      ) : (
        <div className="grid cols-4" style={{ marginBottom: 14 }}>
          <StatTile label={t('today.tile.games')} value={games.length} unit={t('common.unit.games', { count: games.length })}
            hint={finished.length ? t('today.tile.someFinished', { n: finished.length, hits }) : undefined} />
          <StatTile label={t('today.tile.sure')} value={sure ? `${fmt.teamName(favorite(sure, teamById))} ${fmt.pct(conf(sure), 0)}` : '—'} />
          <StatTile label={t('today.tile.close')} value={close ? matchup(close) : '—'}
            hint={close ? t('today.tile.closeHint', { p: close.prediction.homeWinProb }) : undefined} />
          <StatTile label={t('today.tile.split')} value={split ? matchup(split) : '—'}
            hint={split ? t(split.market.edge > 0 ? 'today.tile.splitHome' : 'today.tile.splitAway', { pts: Math.abs(split.market.edge) }) : t('today.tile.noMarket')} />
        </div>
      )}

      {data.loading || !date ? <Loading /> : games.length === 0 ? (
        <div className="card"><div className="empty">{t('today.empty')}</div></div>
      ) : (
        <div className="grid cols-2">
          {games.map((g) => (
            <TodayCard key={g.gameId} game={g} teamById={teamById} outByTeam={outByTeam} out={out} fmt={fmt} t={t} />
          ))}
        </div>
      )}

      <p className="note" style={{ marginTop: 14 }}>
        {t('today.note1')}<b>{t('today.noteBold')}</b>{t('today.note2', { applyOut: t('app.applyOut') })}
      </p>
    </>
  );
}

const conf = (g) => Math.max(g.prediction.homeWinProb, 1 - g.prediction.homeWinProb);
const favorite = (g, teamById) => teamById.get(g.prediction.homeWinProb >= 0.5 ? g.homeId : g.awayId) ?? {};

function TodayCard({ game: g, teamById, outByTeam, out, fmt, t }) {
  const home = teamById.get(g.homeId);
  const away = teamById.get(g.awayId);
  const p = g.prediction;
  const final = g.homeScore != null;
  const started = !final && Date.parse(g.dateTimeUtc) < Date.now();
  const homeFav = p.homeWinProb >= 0.5;
  const spread = -p.margin;

  return (
    <div className="game-card" onClick={() => go(`predict/${g.awayId}/${g.homeId}/${g.gameId}`)}>
      <div className="top">
        <span>
          {t('common.tipoff', { time: fmt.timeZoned(g.dateTimeUtc) })}
          {g.label && <span className="chip blue" style={{ marginLeft: 6 }}>{g.label}</span>}
        </span>
        <span>{g.national?.join(' / ') || g.arena}</span>
      </div>

      <Row team={away} side={t('common.side.away')} fmt={fmt} prob={1 - p.homeWinProb} rest={p.restAway}
        score={final ? g.awayScore : p.awayScore} bold={final ? g.awayScore > g.homeScore : !homeFav} final={final} />
      <div style={{ height: 6 }} />
      <Row team={home} side={g.neutral ? t('common.side.neutral') : t('common.side.home')} fmt={fmt} prob={p.homeWinProb} rest={p.restHome}
        score={final ? g.homeScore : p.homeScore} bold={final ? g.homeScore > g.awayScore : homeFav} final={final} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <ProbBar p={p.homeWinProb} width="100%" />
        <span className="mono" style={{ color: probColor(p.homeWinProb), fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' }}>
          {(homeFav ? home : away)?.abbr} {(conf(g) * 100).toFixed(0)}%
        </span>
      </div>

      <div className="note" style={{ marginTop: 8, lineHeight: 1.7 }}>
        {final ? (
          <>
            <span className="chip">{t('today.final')}</span> {t('today.preGame')}{' '}
            <b className="mono">{p.awayScore.toFixed(0)} - {p.homeScore.toFixed(0)}</b>
            {' · '}{t('today.actual')} <b className="mono">{g.awayScore} - {g.homeScore}</b>{' '}
            <span className={`chip ${g.hit ? 'hit' : 'miss'}`}>{g.hit ? t('today.pickRight') : t('today.pickWrong')}</span>
          </>
        ) : (
          <>
            {started && <><span className="chip injury-dtd">{t('today.started')}</span> {t('today.scorePending')} · </>}
            {t('today.spreadHome')} <b className="mono">{spread > 0 ? `+${spread.toFixed(1)}` : spread.toFixed(1)}</b>
            {' · '}{t('today.total')} <b className="mono">{p.total.toFixed(0)}</b>
            {g.market && (
              <>
                {' · '}{t('today.line')} <b className="mono">{g.market.spread > 0 ? `+${g.market.spread}` : g.market.spread}</b>
                <span className={Math.abs(g.market.edge) >= 3 ? 'pos' : 'dim'}>
                  {t('today.gap', { edge: g.market.edge > 0 ? `+${g.market.edge}` : g.market.edge })}
                </span>
              </>
            )}
          </>
        )}
      </div>

      {!final && [away, home].map((tm) => (
        <Injuries key={tm?.teamId} team={tm} list={outByTeam.get(tm?.teamId) ?? []} applied={out?.[tm?.teamId] ?? []} t={t} />
      ))}
    </div>
  );
}

function Row({ team, side, prob, rest, score, bold, final, fmt }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <TeamLogo team={team} size={24} />
      <span style={{
        flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontSize: 13, fontWeight: bold ? 700 : 400, color: bold ? 'var(--text)' : 'var(--text-dim)',
      }}>
        {fmt.teamName(team)}
        <span className="dim" style={{ fontSize: 11, marginLeft: 6, fontWeight: 400 }}>
          {side} · {team?.wins}-{team?.losses}
        </span>
        {rest === 0 && <span className="chip injury-dtd" style={{ marginLeft: 6 }}>{fmt.rest(rest)}</span>}
      </span>
      {!final && <span className="mono dim" style={{ fontSize: 11 }}>{(prob * 100).toFixed(0)}%</span>}
      <span className="mono" style={{ minWidth: 30, textAlign: 'right', fontWeight: bold ? 750 : 500, color: bold ? 'var(--text)' : 'var(--text-dim)' }}>
        {final ? score : score.toFixed(0)}
      </span>
    </div>
  );
}

/** 伤病名单：标出哪些人已经计入了预测（被勾选为缺阵） */
function Injuries({ team, list, applied, t }) {
  const outs = list.filter((i) => i.status === 'out');
  const dtd = list.filter((i) => i.status !== 'out');
  if (!outs.length && !dtd.length) return null;
  const on = new Set(applied);
  return (
    <div className="note" style={{ marginTop: 4, lineHeight: 1.6 }}>
      <b>{team?.abbr}</b>{' '}
      {outs.map((i) => (
        <span key={i.playerId} className="chip injury-out" style={{ marginRight: 4 }}
          title={`${i.type ?? ''} ${i.detail ?? ''} · ${on.has(i.playerId) ? t('today.counted') : t('today.notCounted')}`}>
          {i.name}{on.has(i.playerId) ? ' ✓' : ''}
        </span>
      ))}
      {dtd.length > 0 && <span className="dim">{t('today.dtdCount', { count: dtd.length })}</span>}
    </div>
  );
}
