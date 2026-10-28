import React, { useEffect, useMemo, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api, withOut } from '../lib/api.js';
import { TeamLogo, Loading, ErrorBox, ProbBar, StatTile } from '../components/common.jsx';
import {
  fmtDate, probColor, restLabel, snapshotAge, bjToday, bjDateOf, bjTimeOf, shiftDate,
} from '../lib/format.js';

/**
 * 今日比赛：按北京时间取一天的比赛，逐场给出模型预测。
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
  const [dates, setDates] = useState(null);
  const [date, setDate] = useState(initial[0] || null);
  const [data, setData] = useState({ loading: true });

  useEffect(() => { setAccent(null); }, [setAccent]);

  // 日期写在地址里（#/today/2026-10-28），可以分享，浏览器前进后退也跟着走
  const routeDate = initial[0] || null;
  useEffect(() => { if (routeDate) setDate(routeDate); }, [routeDate]);

  // 有比赛的北京日期，用来定默认日期和前后翻页
  useEffect(() => {
    let alive = true;
    api.schedule({ type: 'all', predict: '0' })
      .then((d) => {
        if (!alive) return;
        const set = new Set(d.games.filter((g) => g.type !== 'preseason').map((g) => bjDateOf(g.dateTimeUtc)));
        setDates([...set].filter(Boolean).sort());
      })
      .catch((error) => alive && setData({ loading: false, error }));
    return () => { alive = false; };
  }, []);

  // 没指定日期：今天有比赛就是今天，否则下一个比赛日（休赛期则是最后一个）
  useEffect(() => {
    if (date || !dates?.length) return;
    const today = bjToday();
    setDate(dates.find((d) => d >= today) ?? dates[dates.length - 1]);
  }, [dates, date]);

  useEffect(() => {
    if (!date) return undefined;
    let alive = true;
    setData((d) => ({ ...d, loading: true }));
    // 北京日期 X 的比赛几乎都是美东 X-1 晚上打的，少数午场落在美东 X，两天都取
    api.schedule(withOut({ ...params, type: 'all', from: shiftDate(date, -1), to: date }, out))
      .then((d) => {
        if (!alive) return;
        const games = d.games
          .filter((g) => g.type !== 'preseason' && bjDateOf(g.dateTimeUtc) === date)
          .sort((a, b) => a.dateTimeUtc.localeCompare(b.dateTimeUtc));
        setData({ loading: false, games });
      })
      .catch((error) => alive && setData({ loading: false, error }));
    return () => { alive = false; };
  }, [date, params, out]);

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
  const age = snapshotAge(meta.fetchedAt, { staleDays: 1 });
  const isToday = date === bjToday();
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
        <h1>{isToday ? '今日比赛' : '比赛日'}预测</h1>
        <p>按北京时间分日，每场给出模型胜率、预测比分与让分。点击比赛进入详细预测与分差拆解。</p>
      </div>

      <div className="toolbar">
        <button className="btn" disabled={!prev} onClick={() => prev && pick(prev)}>‹ 前一个比赛日</button>
        <div className="field" style={{ minWidth: 0 }}>
          <b style={{ fontSize: 15 }}>{date ? fmtDate(date) : '—'}</b>
          <span className="dim" style={{ marginLeft: 8 }}>北京时间{isToday ? ' · 今天' : ''}</span>
        </div>
        <button className="btn" disabled={!next} onClick={() => next && pick(next)}>后一个比赛日 ›</button>
        {!isToday && dates?.length > 0 && (
          <button className="btn" onClick={() => pick(dates.find((d) => d >= bjToday()) ?? dates[dates.length - 1])}>
            回到今天
          </button>
        )}
      </div>

      {age && (
        <div className={age.stale ? 'market-stale' : 'note'} style={{ marginBottom: 12 }}>
          数据截至 {meta.lastResultDate ?? '—'} 的比赛结果（{age.text}抓取）。评级、伤病和盘口都停在那一刻，
          之后打完的比赛要等下次数据刷新才有比分。
        </div>
      )}

      {review ? (
        <div className="grid cols-4" style={{ marginBottom: 14 }}>
          <StatTile label="比赛场次" value={games.length} unit=" 场" hint="已全部结束" />
          <StatTile label="赛前预测猜对胜方" value={`${hits} / ${finished.length}`}
            hint={`命中率 ${((hits / finished.length) * 100).toFixed(0)}%，单日样本很小`} />
          <StatTile label="最大冷门" value={matchup(upset)}
            hint={`赢球一方赛前胜率只有 ${(winProb(upset) * 100).toFixed(0)}%`} />
          <StatTile label="分差预测最准" value={matchup(sharpest)}
            hint={`预测与实际分差只差 ${marginErr(sharpest).toFixed(1)} 分`} />
        </div>
      ) : (
        <div className="grid cols-4" style={{ marginBottom: 14 }}>
          <StatTile label="比赛场次" value={games.length} unit=" 场"
            hint={finished.length ? `其中 ${finished.length} 场已结束，猜对 ${hits} 场` : undefined} />
          <StatTile label="最有把握" value={sure ? `${favorite(sure, teamById).cn} ${(conf(sure) * 100).toFixed(0)}%` : '—'} />
          <StatTile label="最胶着" value={close ? matchup(close) : '—'}
            hint={close ? `主队胜率 ${(close.prediction.homeWinProb * 100).toFixed(0)}%` : undefined} />
          <StatTile label="与盘口分歧最大" value={split ? matchup(split) : '—'}
            hint={split ? `模型比盘口${split.market.edge > 0 ? '更看好主队' : '更看好客队'} ${Math.abs(split.market.edge)} 分` : '暂无盘口'} />
        </div>
      )}

      {data.loading || !date ? <Loading /> : games.length === 0 ? (
        <div className="card"><div className="empty">这一天没有比赛</div></div>
      ) : (
        <div className="grid cols-2">
          {games.map((g) => (
            <TodayCard key={g.gameId} game={g} teamById={teamById} outByTeam={outByTeam} out={out} />
          ))}
        </div>
      )}

      <p className="note" style={{ marginTop: 14 }}>
        胜率与比分只把你在侧栏或球队页勾选的缺阵球员计入；伤病名单默认<b>不计入</b>正式预测。
        侧栏「套用「确定缺阵」」是实验功能：按 IMP 估算缺阵影响，未经回测验证（伤病影响正在影子模式检验）。已结束比赛的预测用开打前的评级重算，且不套用缺阵勾选，
        所以「猜对胜方」反映的是赛前判断；但名单和模型参数是现在的，并不是当时存档的那一份。
      </p>
    </>
  );
}

const conf = (g) => Math.max(g.prediction.homeWinProb, 1 - g.prediction.homeWinProb);
const favorite = (g, teamById) => teamById.get(g.prediction.homeWinProb >= 0.5 ? g.homeId : g.awayId) ?? {};

function TodayCard({ game: g, teamById, outByTeam, out }) {
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
          {bjTimeOf(g.dateTimeUtc)} 开打
          {g.label && <span className="chip blue" style={{ marginLeft: 6 }}>{g.label}</span>}
        </span>
        <span>{g.national?.join(' / ') || g.arena}</span>
      </div>

      <Row team={away} side="客" prob={1 - p.homeWinProb} rest={p.restAway}
        score={final ? g.awayScore : p.awayScore} bold={final ? g.awayScore > g.homeScore : !homeFav} final={final} />
      <div style={{ height: 6 }} />
      <Row team={home} side={g.neutral ? '中立' : '主'} prob={p.homeWinProb} rest={p.restHome}
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
            <span className="chip">终</span> 赛前预测{' '}
            <b className="mono">{p.awayScore.toFixed(0)} - {p.homeScore.toFixed(0)}</b>
            {' · '}实际 <b className="mono">{g.awayScore} - {g.homeScore}</b>{' '}
            <span className={`chip ${g.hit ? 'hit' : 'miss'}`}>{g.hit ? '✓ 猜对胜方' : '✗ 猜错胜方'}</span>
          </>
        ) : (
          <>
            {started && <><span className="chip injury-dtd">已开赛</span> 比分待数据刷新 · </>}
            让分 主队 <b className="mono">{spread > 0 ? `+${spread.toFixed(1)}` : spread.toFixed(1)}</b>
            {' · '}总分 <b className="mono">{p.total.toFixed(0)}</b>
            {g.market && (
              <>
                {' · '}盘口 <b className="mono">{g.market.spread > 0 ? `+${g.market.spread}` : g.market.spread}</b>
                <span className={Math.abs(g.market.edge) >= 3 ? 'pos' : 'dim'}>
                  （分歧 {g.market.edge > 0 ? `+${g.market.edge}` : g.market.edge}）
                </span>
              </>
            )}
          </>
        )}
      </div>

      {!final && [away, home].map((t) => (
        <Injuries key={t?.teamId} team={t} list={outByTeam.get(t?.teamId) ?? []} applied={out?.[t?.teamId] ?? []} />
      ))}
    </div>
  );
}

function Row({ team, side, prob, rest, score, bold, final }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <TeamLogo team={team} size={24} />
      <span style={{
        flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontSize: 13, fontWeight: bold ? 700 : 400, color: bold ? 'var(--text)' : 'var(--text-dim)',
      }}>
        {team?.cn}
        <span className="dim" style={{ fontSize: 11, marginLeft: 6, fontWeight: 400 }}>
          {side} · {team?.wins}-{team?.losses}
        </span>
        {rest === 0 && <span className="chip injury-dtd" style={{ marginLeft: 6 }}>{restLabel(rest)}</span>}
      </span>
      {!final && <span className="mono dim" style={{ fontSize: 11 }}>{(prob * 100).toFixed(0)}%</span>}
      <span className="mono" style={{ minWidth: 30, textAlign: 'right', fontWeight: bold ? 750 : 500, color: bold ? 'var(--text)' : 'var(--text-dim)' }}>
        {final ? score : score.toFixed(0)}
      </span>
    </div>
  );
}

/** 伤病名单：标出哪些人已经计入了预测（被勾选为缺阵） */
function Injuries({ team, list, applied }) {
  const outs = list.filter((i) => i.status === 'out');
  const dtd = list.filter((i) => i.status !== 'out');
  if (!outs.length && !dtd.length) return null;
  const on = new Set(applied);
  return (
    <div className="note" style={{ marginTop: 4, lineHeight: 1.6 }}>
      <b>{team?.abbr}</b>{' '}
      {outs.map((i) => (
        <span key={i.playerId} className="chip injury-out" style={{ marginRight: 4 }}
          title={`${i.type ?? ''} ${i.detail ?? ''}${on.has(i.playerId) ? ' · 已计入预测' : ' · 未计入预测'}`}>
          {i.name}{on.has(i.playerId) ? ' ✓' : ''}
        </span>
      ))}
      {dtd.length > 0 && <span className="dim">观察 {dtd.length} 人</span>}
    </div>
  );
}
