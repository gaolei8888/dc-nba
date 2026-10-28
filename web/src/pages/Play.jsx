import React, { useEffect, useMemo, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { useI18n } from '../i18n/react.jsx';
import { tzDateOf } from '../i18n/fmt.js';
import { errorText } from '../lib/apiError.js';
import { api } from '../lib/api.js';
import { TeamLogo, StatTile, Loading, ErrorBox, ProbBar, Segmented } from '../components/common.jsx';
import {
  pct, fmtDateFull, restLabel, probColor,
} from '../lib/format.js';
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
    .catch((e) => setLive((cur) => (cur?.available ? cur : { available: false, reasonText: `加载失败：${errorText(e, t)}`, days: [] })));
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
        <h1>人机对赌</h1>
        <div style={{ marginTop: 8 }}>
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'live', label: `本季实战 · ${meta.targetSeason}` },
              { value: 'replay', label: `上季回放 · ${meta.priorSeason}` },
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
            题库为空。请先运行 <code>npm run ingest</code> 生成对赌题库
            （它需要上上个赛季的数据来给上赛季定开赛日评级）。
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
          <span className="chip blue" style={{ fontSize: 13, fontWeight: 750 }}>上季回放 · {season}</span>
          <b>这些是 {season} 赛季已经打完的比赛，不是今晚的比赛。</b>
        </p>
        <p style={{ margin: '2px 0' }}>
          模型的判断是逐日重放生成的——它在每场比赛前只能看到那场之前发生的事，和你拿到的信息一样多。
          比分网上都查得到，所以这里只是练习；要和模型真刀真枪比，去「本季实战」。
        </p>
      </div>

      <div className="grid cols-5" style={{ marginBottom: 14 }}>
        <StatTile label="已预测" value={total.n} unit=" 场" />
        <StatTile
          label="你的命中率"
          value={total.n ? pct(total.accuracy, 1) : '—'}
          hint={`模型 ${total.n ? pct(total.modelAccuracy, 1) : '—'}`}
        />
        <StatTile
          label="总积分"
          value={total.n ? (total.points > 0 ? `+${total.points}` : total.points) : '—'}
          hint={`模型同口径 ${total.modelPoints}`}
        />
        <StatTile
          label="对模型领先"
          value={total.n ? (lead > 0 ? `+${lead}` : lead) : '—'}
          hint="你的积分减去模型的积分"
        />
        <StatTile label="当前连胜" value={total.streak} unit={` / 最佳 ${total.bestStreak}`} />
      </div>

      <div className="card">
        <h2 style={{ flexWrap: 'wrap', rowGap: 8 }}>
          比赛日
          <span className="sub">
            {fmtDateFull(cursor)} · {season} 第 {dayIdx + 1} / {index.days.length} 天 · {games.length} 场
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', maxWidth: '100%' }}>
            <button className="btn" disabled={dayIdx <= 0} onClick={() => move(-1)}>← 前一天</button>
            <select
              value={cursor ?? ''}
              onChange={(e) => { update((p) => ({ ...p, cursor: e.target.value })); setPending({}); }}
              style={{ minWidth: 0, maxWidth: '100%' }}
            >
              {index.days.map((d) => (
                <option key={d.date} value={d.date}>{fmtDateFull(d.date)}（{d.games} 场）</option>
              ))}
            </select>
            <button
              className="btn"
              disabled={dayIdx >= index.days.length - 1}
              onClick={() => move(1)}
            >
              后一天 →
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
                {allSettled ? '本日已结算' : `提交并翻牌（${readyCount}/${games.length}）`}
              </button>
              {allSettled && dayIdx < index.days.length - 1 && (
                <button className="btn" onClick={() => move(1)}>进入下一个比赛日 →</button>
              )}
              <span className="note">
                翻牌前看不到模型的选择和真实比分。可以只预测其中几场。
                {leaderboardOn && cloud?.token && (
                  <>
                    {' · '}
                    {syncState === 'syncing' ? '正在同步排行榜…'
                      : syncState === 'ok' ? '已同步到排行榜'
                        : syncState === 'fail' ? '排行榜同步失败（不影响本地进度）'
                          : '结算后会自动同步到排行榜'}
                  </>
                )}
              </span>
            </div>
          </>
        )}
      </div>

      {total.n > 0 && (
        <div className="card">
          <h2>你 vs 模型 · 上季回放 <span className="sub">基于已结算的 {total.n} 场（与本季实战分开计）</span></h2>
          <div className="grid cols-4">
            <Compare label="命中率" you={pct(total.accuracy, 1)} model={pct(total.modelAccuracy, 1)} youBetter={total.accuracy > total.modelAccuracy} />
            <Compare label="Brier（越低越好）" you={total.brier.toFixed(4)} model={total.modelBrier.toFixed(4)} youBetter={total.brier < total.modelBrier} />
            <Compare label="积分" you={total.points} model={total.modelPoints} youBetter={total.points > total.modelPoints} />
            <Compare label="猜对场次" you={total.correct} model={total.modelCorrect} youBetter={total.correct > total.modelCorrect} />
          </div>
          <div className="divider" />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              className="btn"
              onClick={() => { setPlay(resetPlay(profileId)); setPending({}); }}
            >
              清空存档
            </button>
            <span className="note">
              存档保存在这台浏览器本地（localStorage），换设备或清缓存会丢失。
            </span>
          </div>
        </div>
      )}

      <div className="card plain">
        <h2>计分规则<span className="sub">本季实战与上季回放相同</span></h2>
        <p className="note">
          猜对得 <b>(信心 − 50%) × 200</b> 分，猜错扣同样的分。信心 55% 猜对只得 10 分，
          信心 95% 猜对得 90 分、猜错扣 90 分。<br />
          这样设计是为了让"敢下重注"只有在你的判断确实优于抛硬币时才划算——
          否则最优策略永远是把信心拉满。<br />
          <b>Brier</b> 是和模型同口径的比较：把你的选择折算成"主队获胜概率"再算平方误差，
          越低越好。模型在 {season} 全季的 Brier 约 0.21。
        </p>
      </div>
    </>
  );
}

const REJECT_CN = { locked: '已开赛，锁定了', unknown: '不是本季可下的比赛', side: '方向不对' };
/** 开赛时刻：按所选时区显示并标明时区；赛程日期仍是美东口径（服务端按美东日锁盘） */
const tipLabel = (utc, tz, fmt) => `${fmtDateFull(tzDateOf(utc, tz)).slice(5)} ${fmt.timeZoned(utc)}`;

/**
 * 本季实战。服务端记下「你的选择 + 模型此刻的赛前预测」，按赛程开赛时间锁定，比分出来后翻牌。
 * 开赛前可以改，改的时候模型快照也跟着更新到那一刻。
 */
function LiveMode({ live, reload, headers }) {
  const { t, tz, fmt } = useI18n();
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
        <h2>本季实战不可用</h2>
        <p className="note">{live.reasonText ?? (live.reasonCode ? t(live.reasonCode) : live.reason)}<br />「上季回放」不受影响。</p>
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
      setMsg(r.rejected.length
        ? `已保存 ${r.saved} 场；${r.rejected.map((x) => `${x.gameId} ${REJECT_CN[x.reason] ?? x.reason}`).join('，')}`
        : `已保存 ${r.saved} 场。开赛前还能改。`);
      setPending({});
      await reload(live.date);
    } catch (e) {
      setMsg(`提交失败：${errorText(e, t)}`);
    }
    setBusy(false);
  };

  return (
    <>
      <div className="warn-box" style={{ marginBottom: 14 }}>
        <p style={{ margin: '2px 0', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="chip accent" style={{ fontSize: 13, fontWeight: 750 }}>本季实战 · {live.season}</span>
          <b>本季真实比赛，开赛前提交，开赛即锁定（以服务器时间为准），比分出来后翻牌。</b>
        </p>
        <p style={{ margin: '2px 0' }}>
          提交时服务器同时记下模型<b>那一刻</b>的赛前预测（胜率与所用 Elo），模型按它赛前说过的话计分，不按赛后更新过的评级。
          开赛前可以改，改的时候模型快照一起更新。战绩与「上季回放」分开计。
        </p>
      </div>

      {live.identity === 'cloud' && !live.signedIn && (
        <div className="card plain">
          <p className="note" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: 0 }}>
            本季实战的选择存在服务器上（才能按开赛时间锁定），需要先给当前档案建一个线上身份。
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => { setBusy(true); try { await connectCloud(); } catch (e) { setMsg(errorText(e, t)); } setBusy(false); }}
            >
              用当前档案加入
            </button>
          </p>
        </div>
      )}

      <div className="grid cols-5" style={{ marginBottom: 14 }}>
        <StatTile label="已翻牌" value={total.n} unit=" 场" hint={`另有 ${waiting} 场等比分`} />
        <StatTile label="你的命中率" value={total.n ? pct(total.accuracy, 1) : '—'} hint={`模型 ${total.n ? pct(total.modelAccuracy, 1) : '—'}`} />
        <StatTile label="总积分" value={total.n ? (total.points > 0 ? `+${total.points}` : total.points) : '—'} hint={`模型同口径 ${total.modelPoints}`} />
        <StatTile label="对模型领先" value={total.n ? (lead > 0 ? `+${lead}` : lead) : '—'} hint="你的积分减去模型的积分" />
        <StatTile label="当前连胜" value={total.streak} unit={` / 最佳 ${total.bestStreak}`} />
      </div>

      <div className="card">
        <h2 style={{ flexWrap: 'wrap', rowGap: 8 }}>
          比赛日
          <span className="sub">
            {t('tz.short.et')} {fmtDateFull(live.date)} · {games.length} 场，还能下 {day?.open ?? 0} 场
          </span>
          <span style={{ marginLeft: 'auto' }}>
            <select value={live.date ?? ''} onChange={(e) => reload(e.target.value)} style={{ minWidth: 0, maxWidth: '100%' }}>
              {live.days.map((d) => (
                <option key={d.date} value={d.date}>{fmtDateFull(d.date)}（{d.open ? `可下 ${d.open} 场` : '已开赛，看翻牌'}）</option>
              ))}
            </select>
          </span>
        </h2>

        {!games.length ? <div className="empty">近期没有还能预测的本季比赛</div> : (
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
                        {g.locked ? '已开赛 · 锁定' : `${tipLabel(g.tipoff, tz, fmt)} 开赛`}
                        {saved && !g.locked && <span className="chip hit" style={{ marginLeft: 6 }}>已提交{pending[g.gameId] ? ' · 改动未保存' : ''}</span>}
                      </>
                    )}
                    onChoose={(side, conf) => setPending((p) => ({ ...p, [g.gameId]: { side, conf } }))}
                  />
                );
              })}
            </div>
            <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn primary" disabled={busy || !ready || (live.identity === 'cloud' && !live.signedIn)} onClick={submit}>
                {busy ? '提交中…' : `提交（${ready} 场）`}
              </button>
              <span className="note">
                {msg ?? '可以只预测其中几场。翻牌前看不到模型的选择；比分由每天的数据刷新带进来。'}
                {live.identity === 'local' && ' · 本地模式：存在本机服务的 data/app.db，按当前档案区分。'}
              </span>
            </div>
          </>
        )}
      </div>

      {(live.history ?? []).length > 0 && (
        <div className="card">
          <h2>我的本季实战记录<span className="sub">共 {live.history.length} 场 · 已翻牌 {total.n} · 等比分 {waiting}</span></h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="left">日期（{t('tz.short.et')}）</th><th className="left">对阵</th><th className="left">你押</th>
                  <th>比分</th><th>你</th><th>模型（提交时）</th><th>模型</th>
                </tr>
              </thead>
              <tbody>
                {[...live.history].reverse().map((r) => {
                  const nm = (id) => teamById.get(id)?.cn ?? id;
                  return (
                    <tr key={r.gameId}>
                      <td className="left">{fmtDateFull(r.date)}</td>
                      <td className="left">{nm(r.awayId)} @ {nm(r.homeId)}</td>
                      <td className="left">{nm(r.side === 'home' ? r.homeId : r.awayId)} {Math.round(r.conf * 100)}%</td>
                      <td className="mono">{r.result ? `${r.result.awayScore}-${r.result.homeScore}` : '等比分'}</td>
                      <td className="mono">{r.result ? <b className={r.points > 0 ? 'pos' : 'neg'}>{r.points > 0 ? `+${r.points}` : r.points}</b> : '—'}</td>
                      <td className="mono">{r.result ? `主队 ${(r.modelProb * 100).toFixed(0)}%` : '翻牌后显示'}</td>
                      <td className="mono">{r.result ? <span className={r.modelPoints > 0 ? 'pos' : 'neg'}>{r.modelPoints > 0 ? `+${r.modelPoints}` : r.modelPoints}</span> : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {total.n > 0 && total.n < 30 && <p className="note">才 {total.n} 场，输赢里运气占大头，别急着下结论。</p>}
          {leaderboardOn && cloud?.token && <p className="note">本季实战有单独的排行榜，在「玩家档案」页切换查看。</p>}
        </div>
      )}
      <p className="note">数据快照 {live.dataAt ? new Date(live.dataAt).toLocaleString('zh-CN', { hour12: false }) : '—'} · 服务器时间 {new Date(live.now).toLocaleString('zh-CN', { hour12: false })} · 模型是 {meta.targetSeason} 生产默认预测（不套缺阵勾选）</p>
    </>
  );
}

function Compare({ label, you, model, youBetter }) {
  return (
    <div className="tile">
      <div className="k">{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 6 }}>
        <span style={{ fontSize: 20, fontWeight: 760, color: youBetter ? 'var(--good)' : 'var(--text)' }}>
          {you}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>你</span>
        <span style={{ marginLeft: 'auto', fontSize: 15, fontWeight: 650, color: 'var(--text-dim)' }}>
          {model}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>模型</span>
      </div>
    </div>
  );
}

/**
 * 一场比赛的选择卡。reveal 是翻牌后要显示的东西（主队胜负、比分、模型概率）：
 * 回放直接用题库行；本季实战用服务端结算行（模型概率是提交那一刻的快照）。
 */
function GameRow({ game, teamById, settled, choice, onChoose, reveal = game, locked = false, status = null }) {
  const home = teamById.get(game.homeId);
  const away = teamById.get(game.awayId);
  const picked = settled ?? choice;
  const side = picked?.side;
  const conf = picked?.conf ?? 0.65;
  const frozen = !!settled || locked;

  return (
    <div className="game-card" style={{ cursor: 'default' }}>
      <div className="top">
        <span>{status ?? `${restLabel(game.restAway)} / ${restLabel(game.restHome)}`}</span>
        {settled && (
          <span style={{ color: settled.correct ? 'var(--good)' : 'var(--bad)', fontWeight: 700 }}>
            {settled.correct ? '猜对' : '猜错'} {settled.points > 0 ? `+${settled.points}` : settled.points}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <SideButton
          team={away} label="客"
          active={side === 'away'}
          disabled={frozen}
          won={settled ? !reveal.homeWin : null}
          score={settled ? reveal.awayScore : null}
          onClick={() => onChoose('away', conf)}
        />
        <SideButton
          team={home} label="主"
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
            信心 · 猜对 {Math.round((conf - 0.5) * 200)} 分 / 猜错 −{Math.round((conf - 0.5) * 200)} 分
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
            ? `已锁定：你押 ${side === 'home' ? home?.cn : away?.cn} ${Math.round(conf * 100)}% · 等比分出来翻牌`
            : '已开赛，没有预测这一场'}
        </div>
      )}

      {settled && (
        <div style={{ marginTop: 9, fontSize: 11, color: 'var(--text-faint)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 46 }}>模型</span>
            <ProbBar p={reveal.modelProb} width={54} />
            <span className="mono" style={{ color: probColor(reveal.modelProb) }}>
              {(reveal.modelProb * 100).toFixed(0)}% 主队
            </span>
            <span style={{ marginLeft: 'auto', color: settled.modelCorrect ? 'var(--good)' : 'var(--bad)' }}>
              {settled.modelCorrect ? '模型对' : '模型错'}
            </span>
          </div>
          <div style={{ marginTop: 3 }}>
            你押 {side === 'home' ? home?.abbr : away?.abbr} {Math.round(conf * 100)}% ·
            {' '}实际 {reveal.awayScore}-{reveal.homeScore}
          </div>
        </div>
      )}
    </div>
  );
}

function SideButton({ team, label, active, disabled, won, score, onClick }) {
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
          {team?.cn}
        </span>
      </span>
      {score !== null && score !== undefined && (
        <span className="mono" style={{ fontWeight: 750, fontSize: 15 }}>{score}</span>
      )}
    </button>
  );
}
