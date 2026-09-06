import React, { useEffect, useMemo, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api } from '../lib/api.js';
import { TeamLogo, StatTile, Loading, ErrorBox, ProbBar } from '../components/common.jsx';
import { num, pct, fmtDate, restLabel, probColor } from '../lib/format.js';
import {
  loadPlay, savePlay, resetPlay, scorePick, summarize,
} from '../lib/store.js';

/** 信心档位。50% 是"不确定"，押满 95% 猜错要扣 90 分 */
const CONF_STEPS = [0.55, 0.65, 0.75, 0.85, 0.95];

export default function Play() {
  const { teamById, setAccent } = useApp();
  const [index, setIndex] = useState(null);
  const [day, setDay] = useState(null);
  const [error, setError] = useState(null);
  const [play, setPlay] = useState(loadPlay);
  const [pending, setPending] = useState({}); // gameId -> { side, conf } 尚未提交

  useEffect(() => { setAccent(null); }, [setAccent]);

  // 比赛日索引
  useEffect(() => {
    api.gamedays()
      .then((d) => {
        setIndex(d);
        setPlay((p) => {
          if (p.cursor && d.days.some((x) => x.date === p.cursor)) return p;
          return savePlay({ ...p, cursor: d.days[0]?.date ?? null });
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

  const update = (fn) => setPlay((p) => savePlay(fn(p)));

  /** 已结算的全部记录，用来算总战绩 */
  const settledRows = useMemo(() => Object.values(play.settled ?? {}), [play.settled]);
  const total = useMemo(() => summarize(settledRows), [settledRows]);

  if (error) return <ErrorBox error={error} />;
  if (!index) return <Loading />;

  if (!index.days?.length) {
    return (
      <>
        <div className="page-head"><h1>人机对赌</h1></div>
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
      return { ...p, picks, settled };
    });
    setPending({});
  };

  const move = (delta) => {
    const next = index.days[dayIdx + delta];
    if (next) { update((p) => ({ ...p, cursor: next.date })); setPending({}); }
  };

  const lead = total.points - total.modelPoints;

  return (
    <>
      <div className="page-head">
        <h1>人机对赌</h1>
        <p>
          对 {index.season} 赛季的真实比赛做预测，跟模型同台竞技。
          模型的判断是逐日重放生成的——它在每场比赛前只能看到那场之前发生的事，
          和你拿到的信息一样多。
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
        <h2>
          比赛日
          <span className="sub">
            {fmtDate(cursor)} · 第 {dayIdx + 1} / {index.days.length} 天 · {games.length} 场
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="btn" disabled={dayIdx <= 0} onClick={() => move(-1)}>← 前一天</button>
            <select
              value={cursor ?? ''}
              onChange={(e) => { update((p) => ({ ...p, cursor: e.target.value })); setPending({}); }}
              style={{ minWidth: 150 }}
            >
              {index.days.map((d) => (
                <option key={d.date} value={d.date}>{fmtDate(d.date)}（{d.games} 场）</option>
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
              </span>
            </div>
          </>
        )}
      </div>

      {total.n > 0 && (
        <div className="card">
          <h2>你 vs 模型 <span className="sub">基于已结算的 {total.n} 场</span></h2>
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
              onClick={() => { setPlay(resetPlay()); setPending({}); }}
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
        <h2>计分规则</h2>
        <p className="note">
          猜对得 <b>(信心 − 50%) × 200</b> 分，猜错扣同样的分。信心 55% 猜对只得 10 分，
          信心 95% 猜对得 90 分、猜错扣 90 分。<br />
          这样设计是为了让"敢下重注"只有在你的判断确实优于抛硬币时才划算——
          否则最优策略永远是把信心拉满。<br />
          <b>Brier</b> 是和模型同口径的比较：把你的选择折算成"主队获胜概率"再算平方误差，
          越低越好。模型在 {index.season} 全季的 Brier 约 0.21。
        </p>
      </div>
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

function GameRow({ game, teamById, settled, choice, onChoose }) {
  const home = teamById.get(game.homeId);
  const away = teamById.get(game.awayId);
  const picked = settled ?? choice;
  const side = picked?.side;
  const conf = picked?.conf ?? 0.65;

  return (
    <div className="game-card" style={{ cursor: 'default' }}>
      <div className="top">
        <span>{restLabel(game.restAway)} / {restLabel(game.restHome)}</span>
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
          disabled={!!settled}
          won={settled ? !game.homeWin : null}
          score={settled ? game.awayScore : null}
          onClick={() => onChoose('away', conf)}
        />
        <SideButton
          team={home} label="主"
          active={side === 'home'}
          disabled={!!settled}
          won={settled ? game.homeWin : null}
          score={settled ? game.homeScore : null}
          onClick={() => onChoose('home', conf)}
        />
      </div>

      {!settled && side && (
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

      {settled && (
        <div style={{ marginTop: 9, fontSize: 11, color: 'var(--text-faint)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 46 }}>模型</span>
            <ProbBar p={game.modelProb} width={54} />
            <span className="mono" style={{ color: probColor(game.modelProb) }}>
              {(game.modelProb * 100).toFixed(0)}% 主队
            </span>
            <span style={{ marginLeft: 'auto', color: settled.modelCorrect ? 'var(--good)' : 'var(--bad)' }}>
              {settled.modelCorrect ? '模型对' : '模型错'}
            </span>
          </div>
          <div style={{ marginTop: 3 }}>
            你押 {side === 'home' ? home?.abbr : away?.abbr} {Math.round(conf * 100)}% ·
            {' '}实际 {game.awayScore}-{game.homeScore}
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
