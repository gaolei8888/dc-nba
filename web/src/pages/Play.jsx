import React, { useEffect, useMemo, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { useI18n } from '../i18n/react.jsx';
import { tzDateOf } from '../i18n/fmt.js';
import { errorText } from '../lib/apiError.js';
import { api } from '../lib/api.js';
import { TeamLogo, StatTile, Loading, ErrorBox, ProbBar, Segmented } from '../components/common.jsx';
import { pct, probColor } from '../lib/format.js';
import {
  loadPlay, savePlay, resetPlay, scorePick, summarize,
} from '../lib/store.js';
import { pushPicks } from '../lib/cloud.js';

/** 信心档位。50% 是"不确定"，押满 95% 猜错要扣 90 分 */
const CONF_STEPS = [0.55, 0.65, 0.75, 0.85, 0.95];

/**
 * 两种模式：
 *  - 本季实战：本季真实比赛，开赛前提交、开赛即锁、赛后翻牌（服务端存档与锁定，见 server/livePlay.mjs）；
 *  - 上季回放：上赛季逐日重放的练习题库，提交立即翻牌。
 * 有 24 小时内开赛的比赛就默认进本季实战，否则进上季回放。
 */
export default function Play() {
  const { t } = useI18n();
  const { setAccent, meta, profileId, cloud } = useApp();
  const [tab, setTab] = useState(null);
  const [live, setLive] = useState(null);
  const headers = useMemo(() => ({
    'X-Local-Profile': profileId ?? '',
    ...(cloud?.token ? { Authorization: `Bearer ${cloud.token}` } : {}),
  }), [profileId, cloud?.token]);

  useEffect(() => { setAccent(null); }, [setAccent]);

  // 本季实战接口出错不能连累上季回放：降级成「不可用」，回放照常
  const loadLive = (date) => api.live({ date }, headers).then(setLive)
    .catch((e) => setLive((cur) => (cur?.available ? cur : { available: false, reasonError: e, days: [] })));
  useEffect(() => { loadLive(live?.date); }, [headers]);

  // 默认模式只在第一次拿到数据时定，之后听用户的
  useEffect(() => {
    if (!live || tab) return;
    const next = live.days?.find((d) => d.open)?.nextTipoff;
    setTab(live.available && next && Date.parse(next) - Date.parse(live.now) < 24 * 3600e3 ? 'live' : 'replay');
  }, [live, tab]);

  if (!tab) return <Loading />;

  return (
    <>
      <div className="page-head">
        <h1>{t('play.title')}</h1>
        <div style={{ marginTop: 8 }}>
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'live', label: t('play.modeLive', { season: meta.targetSeason }) },
              { value: 'replay', label: t('play.modeReplay', { season: meta.priorSeason }) },
            ]}
          />
        </div>
      </div>
      {tab === 'live'
        ? <LiveMode live={live} reload={loadLive} headers={headers} />
        : <ReplayMode season={meta.priorSeason} />}
    </>
  );
}

function ReplayMode({ season }) {
  const { t, fmt } = useI18n();
  const unitGames = (n) => `${n}${t('common.unit.games', { count: n })}`;
  const { teamById, profileId, cloud, leaderboardOn } = useApp();
  const [syncState, setSyncState] = useState(null);
  const [index, setIndex] = useState(null);
  const [day, setDay] = useState(null);
  const [error, setError] = useState(null);
  const [play, setPlay] = useState(() => loadPlay(profileId));
  const [pending, setPending] = useState({}); // gameId -> { side, conf } 尚未提交

  // 切换玩家档案时重新载入该档案的进度
  useEffect(() => { setPlay(loadPlay(profileId)); setPending({}); }, [profileId]);

  // 比赛日索引
  useEffect(() => {
    api.gamedays()
      .then((d) => {
        setIndex(d);
        setPlay((p) => {
          if (p.cursor && d.days.some((x) => x.date === p.cursor)) return p;
          return savePlay(profileId, { ...p, cursor: d.days[0]?.date ?? null });
        });
      })
      .catch(setError);
  }, []);

  const cursor = play.cursor;

  // 当天比赛
  useEffect(() => {
    if (!cursor) return;
    let alive = true;
    setDay(null);
    api.gameday(cursor)
      .then((d) => alive && setDay(d))
      .catch((e) => alive && setError(e));
    return () => { alive = false; };
  }, [cursor]);

  const update = (fn) => setPlay((p) => savePlay(profileId, fn(p)));

  /** 已结算的全部记录，用来算总战绩 */
  const settledRows = useMemo(() => Object.values(play.settled ?? {}), [play.settled]);
  const total = useMemo(() => summarize(settledRows), [settledRows]);

  if (error) return <ErrorBox error={error} />;
  if (!index) return <Loading />;


  if (!index.days?.length) {
    return (
      <>
        <div className="card">
          <p className="note">
            {t('play.replay.emptyPre')}<code>npm run ingest</code>{t('play.replay.emptyPost')}
          </p>
        </div>
      </>
    );
  }

  const dayIdx = index.days.findIndex((d) => d.date === cursor);
  const games = day?.games ?? [];
  const allSettled = games.length > 0 && games.every((g) => play.settled[g.gameId]);
  const readyCount = games.filter((g) => pending[g.gameId] || play.settled[g.gameId]).length;

  /** 提交当天所有选择，立即结算 */
  const settleDay = () => {
    let next = null;
    update((p) => {
      const settled = { ...p.settled };
      const picks = { ...p.picks };
      for (const g of games) {
        if (settled[g.gameId]) continue;
        const choice = pending[g.gameId];
        if (!choice) continue;
        picks[g.gameId] = { ...choice, at: new Date().toISOString() };
        settled[g.gameId] = {
          gameId: g.gameId,
          date: g.date,
          ...choice,
          ...scorePick(choice, g),
        };
      }
      next = { ...p, picks, settled };
      return next;
    });
    setPending({});

    // 同步到排行榜。失败不打断游戏——本地存档才是权威，云端只是榜单。
    if (leaderboardOn && cloud?.token && next) {
      setSyncState('syncing');
      pushPicks(cloud.token, next.settled)
        .then((r) => setSyncState(r ? 'ok' : 'fail'))
        .catch(() => setSyncState('fail'));
    }
  };

  const move = (delta) => {
    const next = index.days[dayIdx + delta];
    if (next) { update((p) => ({ ...p, cursor: next.date })); setPending({}); }
  };

  const lead = total.points - total.modelPoints;

  return (
    <>
      <div className="warn-box" style={{ marginBottom: 14 }}>
        <p style={{ margin: '2px 0', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="chip blue" style={{ fontSize: 13, fontWeight: 750 }}>{t('play.modeReplay', { season })}</span>
          <b>{t('play.replay.lead', { season })}</b>
        </p>
        <p style={{ margin: '2px 0' }}>{t('play.replay.explain')}</p>
      </div>

      <div className="grid cols-5" style={{ marginBottom: 14 }}>
        <StatTile label={t('play.stat.predicted')} value={total.n} unit={t('common.unit.games', { count: total.n })} />
        <StatTile
          label={t('play.stat.acc')}
          value={total.n ? pct(total.accuracy, 1) : '—'}
          hint={t('play.stat.modelAcc', { v: total.n ? pct(total.modelAccuracy, 1) : '—' })}
        />
        <StatTile
          label={t('play.stat.points')}
          value={total.n ? (total.points > 0 ? `+${total.points}` : total.points) : '—'}
          hint={t('play.stat.modelPoints', { v: total.modelPoints })}
        />
        <StatTile
          label={t('play.stat.lead')}
          value={total.n ? (lead > 0 ? `+${lead}` : lead) : '—'}
          hint={t('play.stat.leadHint')}
        />
        <StatTile label={t('play.stat.streak')} value={total.streak} unit={t('play.stat.streakUnit', { n: total.bestStreak })} />
      </div>

      <div className="card">
        <h2 style={{ flexWrap: 'wrap', rowGap: 8 }}>
          {t('play.day')}
          <span className="sub">
            {t('play.replay.daySub', {
              date: fmt.dateFull(cursor), season, i: dayIdx + 1, n: index.days.length, games: unitGames(games.length),
            })}
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', maxWidth: '100%' }}>
            <button className="btn" disabled={dayIdx <= 0} onClick={() => move(-1)}>{t('play.replay.prev')}</button>
            <select
              value={cursor ?? ''}
              onChange={(e) => { update((p) => ({ ...p, cursor: e.target.value })); setPending({}); }}
              style={{ minWidth: 0, maxWidth: '100%' }}
            >
              {index.days.map((d) => (
                <option key={d.date} value={d.date}>{t('play.replay.dayOption', { date: fmt.dateFull(d.date), games: unitGames(d.games) })}</option>
              ))}
            </select>
            <button
              className="btn"
              disabled={dayIdx >= index.days.length - 1}
              onClick={() => move(1)}
            >
              {t('play.replay.next')}
            </button>
          </span>
        </h2>

        {!day ? <Loading /> : (
          <>
            <div className="grid cols-2">
              {games.map((g) => (
                <GameRow
                  key={g.gameId}
                  game={g}
                  teamById={teamById}
                  settled={play.settled[g.gameId]}
                  choice={pending[g.gameId]}
                  onChoose={(side, conf) => setPending((p) => ({ ...p, [g.gameId]: { side, conf } }))}
                />
              ))}
            </div>

            <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                className="btn primary"
                disabled={allSettled || readyCount === 0}
                onClick={settleDay}
              >
                {allSettled ? t('play.replay.daySettled') : t('play.replay.submit', { ready: readyCount, total: games.length })}
              </button>
              {allSettled && dayIdx < index.days.length - 1 && (
                <button className="btn" onClick={() => move(1)}>{t('play.replay.nextDay')}</button>
              )}
              <span className="note">
                {t('play.replay.note')}
                {leaderboardOn && cloud?.token && (
                  <>
                    {' · '}
                    {syncState === 'syncing' ? t('play.replay.syncing')
                      : syncState === 'ok' ? t('play.replay.syncOk')
                        : syncState === 'fail' ? t('play.replay.syncFail')
                          : t('play.replay.syncAuto')}
                  </>
                )}
              </span>
            </div>
          </>
        )}
      </div>

      {total.n > 0 && (
        <div className="card">
          <h2>{t('play.vs.title')} <span className="sub">{t('play.vs.sub', { n: total.n })}</span></h2>
          <div className="grid cols-4">
            <Compare label={t('play.vs.acc')} you={pct(total.accuracy, 1)} model={pct(total.modelAccuracy, 1)} youBetter={total.accuracy > total.modelAccuracy} />
            <Compare label={t('play.vs.brier')} you={total.brier.toFixed(4)} model={total.modelBrier.toFixed(4)} youBetter={total.brier < total.modelBrier} />
            <Compare label={t('play.vs.points')} you={total.points} model={total.modelPoints} youBetter={total.points > total.modelPoints} />
            <Compare label={t('play.vs.correct')} you={total.correct} model={total.modelCorrect} youBetter={total.correct > total.modelCorrect} />
          </div>
          <div className="divider" />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              className="btn"
              onClick={() => { setPlay(resetPlay(profileId)); setPending({}); }}
            >
              {t('play.vs.reset')}
            </button>
            <span className="note">{t('play.vs.resetNote')}</span>
          </div>
        </div>
      )}

      <div className="card plain">
        <h2>{t('play.rules.title')}<span className="sub">{t('play.rules.sub')}</span></h2>
        <p className="note">
          {t('play.rules.p1a')}<b>{t('play.rules.formula')}</b>{t('play.rules.p1b')}<br />
          {t('play.rules.p2')}<br />
          <b>Brier</b>{t('play.rules.p3', { season })}
        </p>
      </div>
    </>
  );
}

/** 开赛时刻：按所选时区显示并标明时区；赛程日期仍是美东口径（服务端按美东日锁盘） */
const tipLabel = (utc, tz, fmt) => `${fmt.date(tzDateOf(utc, tz))} ${fmt.timeZoned(utc)}`;

/**
 * 本季实战。服务端记下「你的选择 + 模型此刻的赛前预测」，按赛程开赛时间锁定，比分出来后翻牌。
 * 开赛前可以改，改的时候模型快照也跟着更新到那一刻。
 */
function LiveMode({ live, reload, headers }) {
  const { t, tz, fmt } = useI18n();
  const unitGames = (n) => `${n}${t('common.unit.games', { count: n })}`;
  const { teamById, meta, leaderboardOn, cloud, connectCloud } = useApp();
  const [pending, setPending] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => { setPending({}); setMsg(null); }, [live?.date, headers]);

  const settledRows = useMemo(() => (live?.history ?? []).filter((r) => r.result), [live]);
  const total = useMemo(() => summarize(settledRows), [settledRows]);

  if (!live) return <Loading />;
  if (!live.available) {
    return (
      <div className="card plain">
        <h2>{t('play.live.offTitle')}</h2>
        <p className="note">
          {live.reasonError ? t('play.loadFailed', { msg: errorText(live.reasonError, t) }) : t(live.reasonCode || 'err.liveUnavailable')}<br />{t('play.live.offTail')}
        </p>
      </div>
    );
  }

  const games = live.games ?? [];
  const day = live.days.find((d) => d.date === live.date);
  const ready = Object.keys(pending).length;
  const waiting = (live.history ?? []).filter((r) => !r.result).length;
  const lead = total.points - total.modelPoints;

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const picks = Object.entries(pending).map(([gameId, p]) => ({ gameId, ...p }));
      const r = await api.livePicks(picks, headers);
      const rejectText = (reason) => {
        const k = `play.reject.${reason}`;
        const s = t(k);
        return s === k ? reason : s;
      };
      setMsg(r.rejected.length
        ? t('play.live.savedRejected', { count: r.saved, rejected: r.rejected.map((x) => `${x.gameId} ${rejectText(x.reason)}`).join(t('play.listSep')) })
        : t('play.live.saved', { count: r.saved }));
      setPending({});
      await reload(live.date);
    } catch (e) {
      setMsg(t('play.live.submitFailed', { msg: errorText(e, t) }));
    }
    setBusy(false);
  };

  return (
    <>
      <div className="warn-box" style={{ marginBottom: 14 }}>
        <p style={{ margin: '2px 0', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="chip accent" style={{ fontSize: 13, fontWeight: 750 }}>{t('play.modeLive', { season: live.season })}</span>
          <b>{t('play.live.lead')}</b>
        </p>
        <p style={{ margin: '2px 0' }}>
          {t('play.live.explain1')}<b>{t('play.live.explainBold')}</b>{t('play.live.explain2')}
        </p>
      </div>

      {live.identity === 'cloud' && !live.signedIn && (
        <div className="card plain">
          <p className="note" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: 0 }}>
            {t('play.live.needCloud')}
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => { setBusy(true); try { await connectCloud(); } catch (e) { setMsg(errorText(e, t)); } setBusy(false); }}
            >
              {t('play.live.join')}
            </button>
          </p>
        </div>
      )}

      <div className="grid cols-5" style={{ marginBottom: 14 }}>
        <StatTile label={t('play.live.revealed')} value={total.n} unit={t('common.unit.games', { count: total.n })} hint={t('play.live.waitingHint', { count: waiting })} />
        <StatTile label={t('play.stat.acc')} value={total.n ? pct(total.accuracy, 1) : '—'} hint={t('play.stat.modelAcc', { v: total.n ? pct(total.modelAccuracy, 1) : '—' })} />
        <StatTile label={t('play.stat.points')} value={total.n ? (total.points > 0 ? `+${total.points}` : total.points) : '—'} hint={t('play.stat.modelPoints', { v: total.modelPoints })} />
        <StatTile label={t('play.stat.lead')} value={total.n ? (lead > 0 ? `+${lead}` : lead) : '—'} hint={t('play.stat.leadHint')} />
        <StatTile label={t('play.stat.streak')} value={total.streak} unit={t('play.stat.streakUnit', { n: total.bestStreak })} />
      </div>

      <div className="card">
        <h2 style={{ flexWrap: 'wrap', rowGap: 8 }}>
          {t('play.day')}
          <span className="sub">
            {t('play.live.daySub', {
              tz: t('tz.short.et'), date: fmt.dateFull(live.date), games: unitGames(games.length), open: day?.open ?? 0,
            })}
          </span>
          <span style={{ marginLeft: 'auto' }}>
            <select value={live.date ?? ''} onChange={(e) => reload(e.target.value)} style={{ minWidth: 0, maxWidth: '100%' }}>
              {live.days.map((d) => (
                <option key={d.date} value={d.date}>
                  {d.open
                    ? t('play.live.optOpen', { date: fmt.dateFull(d.date), open: d.open })
                    : t('play.live.optLocked', { date: fmt.dateFull(d.date) })}
                </option>
              ))}
            </select>
          </span>
        </h2>

        {!games.length ? <div className="empty">{t('play.live.empty')}</div> : (
          <>
            <div className="grid cols-2">
              {games.map((g) => {
                const saved = g.pick;
                const settled = saved?.result ? saved : null;
                return (
                  <GameRow
                    key={g.gameId}
                    game={g}
                    teamById={teamById}
                    settled={settled}
                    reveal={settled ? { ...saved.result, modelProb: saved.modelProb } : g}
                    locked={g.locked}
                    choice={pending[g.gameId] ?? (saved ? { side: saved.side, conf: saved.conf } : null)}
                    status={(
                      <>
                        {g.locked ? t('play.live.locked') : t('play.live.tipoff', { time: tipLabel(g.tipoff, tz, fmt) })}
                        {saved && !g.locked && <span className="chip hit" style={{ marginLeft: 6 }}>{t('play.live.submitted')}{pending[g.gameId] ? t('play.live.unsaved') : ''}</span>}
                      </>
                    )}
                    onChoose={(side, conf) => setPending((p) => ({ ...p, [g.gameId]: { side, conf } }))}
                  />
                );
              })}
            </div>
            <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn primary" disabled={busy || !ready || (live.identity === 'cloud' && !live.signedIn)} onClick={submit}>
                {busy ? t('play.live.submitting') : t('play.live.submit', { count: ready })}
              </button>
              <span className="note">
                {msg ?? t('play.live.note')}
                {live.identity === 'local' && t('play.live.localMode')}
              </span>
            </div>
          </>
        )}
      </div>

      {(live.history ?? []).length > 0 && (
        <div className="card">
          <h2>{t('play.hist.title')}<span className="sub">{t('play.hist.sub', { total: unitGames(live.history.length), n: total.n, waiting })}</span></h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="left">{t('play.hist.date', { tz: t('tz.short.et') })}</th><th className="left">{t('play.hist.matchup')}</th><th className="left">{t('play.hist.pick')}</th>
                  <th>{t('play.hist.score')}</th><th>{t('play.hist.you')}</th><th>{t('play.hist.modelAtPick')}</th><th>{t('play.hist.model')}</th>
                </tr>
              </thead>
              <tbody>
                {[...live.history].reverse().map((r) => {
                  const nm = (id) => (teamById.get(id) ? fmt.teamName(teamById.get(id)) : id);
                  return (
                    <tr key={r.gameId}>
                      <td className="left">{fmt.dateFull(r.date)}</td>
                      <td className="left">{nm(r.awayId)} @ {nm(r.homeId)}</td>
                      <td className="left">{nm(r.side === 'home' ? r.homeId : r.awayId)} {Math.round(r.conf * 100)}%</td>
                      <td className="mono">{r.result ? `${r.result.awayScore}-${r.result.homeScore}` : t('play.hist.waiting')}</td>
                      <td className="mono">{r.result ? <b className={r.points > 0 ? 'pos' : 'neg'}>{r.points > 0 ? `+${r.points}` : r.points}</b> : '—'}</td>
                      <td className="mono">{r.result ? t('play.hist.homeProb', { p: (r.modelProb * 100).toFixed(0) }) : t('play.hist.afterReveal')}</td>
                      <td className="mono">{r.result ? <span className={r.modelPoints > 0 ? 'pos' : 'neg'}>{r.modelPoints > 0 ? `+${r.modelPoints}` : r.modelPoints}</span> : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {total.n > 0 && total.n < 30 && <p className="note">{t('play.hist.small', { n: total.n })}</p>}
          {leaderboardOn && cloud?.token && <p className="note">{t('play.hist.boardNote')}</p>}
        </div>
      )}
      <p className="note">
        {t('play.footer', {
          at: live.dataAt ? new Date(live.dataAt).toLocaleString(fmt.intl, { hour12: false }) : '—',
          now: new Date(live.now).toLocaleString(fmt.intl, { hour12: false }),
          season: meta.targetSeason,
        })}
      </p>
    </>
  );
}

function Compare({ label, you, model, youBetter }) {
  const { t } = useI18n();
  return (
    <div className="tile">
      <div className="k">{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 6 }}>
        <span style={{ fontSize: 20, fontWeight: 760, color: youBetter ? 'var(--good)' : 'var(--text)' }}>
          {you}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{t('play.vs.you')}</span>
        <span style={{ marginLeft: 'auto', fontSize: 15, fontWeight: 650, color: 'var(--text-dim)' }}>
          {model}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{t('play.vs.model')}</span>
      </div>
    </div>
  );
}

/**
 * 一场比赛的选择卡。reveal 是翻牌后要显示的东西（主队胜负、比分、模型概率）：
 * 回放直接用题库行；本季实战用服务端结算行（模型概率是提交那一刻的快照）。
 */
function GameRow({ game, teamById, settled, choice, onChoose, reveal = game, locked = false, status = null }) {
  const { t, fmt } = useI18n();
  const home = teamById.get(game.homeId);
  const away = teamById.get(game.awayId);
  const picked = settled ?? choice;
  const side = picked?.side;
  const conf = picked?.conf ?? 0.65;
  const frozen = !!settled || locked;

  return (
    <div className="game-card" style={{ cursor: 'default' }}>
      <div className="top">
        <span>{status ?? `${fmt.rest(game.restAway)} / ${fmt.rest(game.restHome)}`}</span>
        {settled && (
          <span style={{ color: settled.correct ? 'var(--good)' : 'var(--bad)', fontWeight: 700 }}>
            {settled.correct ? t('play.row.hit') : t('play.row.miss')} {settled.points > 0 ? `+${settled.points}` : settled.points}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <SideButton
          team={away} label={t('common.side.away')}
          active={side === 'away'}
          disabled={frozen}
          won={settled ? !reveal.homeWin : null}
          score={settled ? reveal.awayScore : null}
          onClick={() => onChoose('away', conf)}
        />
        <SideButton
          team={home} label={t('common.side.home')}
          active={side === 'home'}
          disabled={frozen}
          won={settled ? reveal.homeWin : null}
          score={settled ? reveal.homeScore : null}
          onClick={() => onChoose('home', conf)}
        />
      </div>

      {!frozen && side && (
        <div style={{ marginTop: 9 }}>
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginBottom: 4 }}>
            {t('play.row.confidence', { n: Math.round((conf - 0.5) * 200) })}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {CONF_STEPS.map((c) => (
              <button
                key={c}
                className={`btn ${c === conf ? 'primary' : ''}`}
                style={{ flex: 1, padding: '4px 0', fontSize: 11 }}
                onClick={() => onChoose(side, c)}
              >
                {Math.round(c * 100)}%
              </button>
            ))}
          </div>
        </div>
      )}

      {locked && !settled && (
        <div style={{ marginTop: 9, fontSize: 11, color: 'var(--text-faint)' }}>
          {side
            ? t('play.row.lockedPick', { team: fmt.teamName(side === 'home' ? home : away), conf: Math.round(conf * 100) })
            : t('play.row.lockedNone')}
        </div>
      )}

      {settled && (
        <div style={{ marginTop: 9, fontSize: 11, color: 'var(--text-faint)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 46 }}>{t('play.vs.model')}</span>
            <ProbBar p={reveal.modelProb} width={54} />
            <span className="mono" style={{ color: probColor(reveal.modelProb) }}>
              {t('play.row.modelHome', { p: (reveal.modelProb * 100).toFixed(0) })}
            </span>
            <span style={{ marginLeft: 'auto', color: settled.modelCorrect ? 'var(--good)' : 'var(--bad)' }}>
              {settled.modelCorrect ? t('play.row.modelRight') : t('play.row.modelWrong')}
            </span>
          </div>
          <div style={{ marginTop: 3 }}>
            {t('play.row.youPicked', {
              abbr: side === 'home' ? home?.abbr : away?.abbr, conf: Math.round(conf * 100), score: `${reveal.awayScore}-${reveal.homeScore}`,
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function SideButton({ team, label, active, disabled, won, score, onClick }) {
  const { fmt } = useI18n();
  const border = won === true ? 'var(--good)' : won === false ? 'var(--bad)' : 'var(--line)';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1,
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '9px 10px',
        borderRadius: 'var(--radius-sm)',
        border: `1px solid ${active ? 'var(--team-raw)' : border}`,
        background: active ? 'var(--team-soft)' : 'var(--glass-2)',
        cursor: disabled ? 'default' : 'pointer',
        textAlign: 'left',
        minWidth: 0,
        outline: won === true ? '1px solid var(--good)' : 'none',
      }}
    >
      <TeamLogo team={team} size={26} />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: 10, color: 'var(--text-faint)', display: 'block' }}>{label}</span>
        <span style={{
          fontSize: 12.5, fontWeight: active ? 700 : 500,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block',
        }}
        >
          {team ? fmt.teamName(team) : undefined}
        </span>
      </span>
      {score !== null && score !== undefined && (
        <span className="mono" style={{ fontWeight: 750, fontSize: 15 }}>{score}</span>
      )}
    </button>
  );
}
