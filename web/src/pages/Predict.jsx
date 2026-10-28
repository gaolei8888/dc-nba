import React, { useEffect, useMemo, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api } from '../lib/api.js';
import {
  TeamLogo, PlayerHeadshot, StatTile, Loading, ErrorBox, DataTable, InjuryBadge, MarketCompare,
} from '../components/common.jsx';
import { num, signed, signClass, rate, fmtDate, restLabel } from '../lib/format.js';
import { inkOn } from '../lib/color.js';

const PARAM_FIELDS = [
  { key: 'homeAdv', label: '主场优势（分）', min: 0, max: 6, step: 0.1 },
  { key: 'wElo', label: 'Elo 权重', min: 0, max: 1, step: 0.05 },
  { key: 'wNet', label: '净效率权重', min: 0, max: 1, step: 0.05 },
  { key: 'restWeight', label: '休息因素强度', min: 0, max: 3, step: 0.1 },
  { key: 'rosterWeight', label: '缺阵影响强度', min: 0, max: 2, step: 0.05 },
  { key: 'turnoverWeight', label: '阵容更迭强度', min: 0, max: 1.5, step: 0.05 },
  { key: 'spreadSd', label: '分差标准差', min: 8, max: 16, step: 0.5 },
];

export default function Predict({ initial = [] }) {
  const { meta, teams, teamById, out, toggleOut, params, setParams, setAccent } = useApp();

  const sorted = useMemo(() => [...teams].sort((a, b) => a.cn.localeCompare(b.cn, 'zh')), [teams]);
  const [awayId, setAwayId] = useState(() => Number(initial[0]) || sorted[0]?.teamId);
  const [homeId, setHomeId] = useState(() => Number(initial[1]) || sorted[1]?.teamId);
  const [gameId, setGameId] = useState(() => initial[2] ?? null);
  const [neutral, setNeutral] = useState(false);
  const [showParams, setShowParams] = useState(false);

  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [rosters, setRosters] = useState({});
  const [matchups, setMatchups] = useState([]);

  const home = teamById.get(homeId);
  const away = teamById.get(awayId);

  // 背景光斑用主队配色
  useEffect(() => {
    if (home) setAccent(home);
    return () => setAccent(null);
  }, [home, setAccent]);

  // 路由变化（从赛程页点进来）时同步选择
  useEffect(() => {
    if (initial[0]) setAwayId(Number(initial[0]));
    if (initial[1]) setHomeId(Number(initial[1]));
    setGameId(initial[2] ?? null);
  }, [initial.join('/')]);

  // 拉取两队名单
  useEffect(() => {
    for (const id of [awayId, homeId]) {
      if (!id || rosters[id]) continue;
      api.players({ teamId: id, onRoster: 1 })
        .then((list) => setRosters((r) => ({
          ...r,
          [id]: list.sort((a, b) => (b.min ?? 0) - (a.min ?? 0)),
        })));
    }
  }, [awayId, homeId]);

  // 两队之间的对阵场次，供选择具体日期
  useEffect(() => {
    if (!awayId || !homeId) return;
    let alive = true;
    api.schedule({ type: 'all', teamId: homeId, predict: 0 })
      .then((d) => {
        if (!alive) return;
        setMatchups(d.games.filter(
          (g) => (g.homeId === homeId && g.awayId === awayId)
            || (g.homeId === awayId && g.awayId === homeId),
        ));
      });
    return () => { alive = false; };
  }, [awayId, homeId]);

  // 预测
  useEffect(() => {
    if (!awayId || !homeId || awayId === homeId) {
      setResult(null);
      setError(awayId === homeId ? new Error('请选择两支不同的球队') : null);
      return;
    }
    let alive = true;
    setError(null);
    api.predict({ homeId, awayId, gameId, neutral, out, params })
      .then((r) => alive && setResult(r))
      .catch((e) => alive && setError(e));
    return () => { alive = false; };
  }, [awayId, homeId, gameId, neutral, out, params]);

  const selectedGame = matchups.find((g) => g.gameId === gameId);
  const swap = () => { setAwayId(homeId); setHomeId(awayId); setGameId(null); };

  return (
    <>
      <div className="page-head">
        <h1>比赛预测</h1>
        <p>任选两队进行模拟对阵，或从赛程中选择具体场次（自动带入休息天数与主客场）。</p>
      </div>

      <div className="card">
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <div className="field">
            <label>客队</label>
            <select
              value={awayId}
              onChange={(e) => { setAwayId(Number(e.target.value)); setGameId(null); }}
              style={{ minWidth: 168 }}
            >
              {sorted.map((t) => <option key={t.teamId} value={t.teamId}>{t.cn}</option>)}
            </select>
          </div>
          <div className="field">
            <label>&nbsp;</label>
            <button className="btn" onClick={swap} title="交换主客">⇄</button>
          </div>
          <div className="field">
            <label>主队</label>
            <select
              value={homeId}
              onChange={(e) => { setHomeId(Number(e.target.value)); setGameId(null); }}
              style={{ minWidth: 168 }}
            >
              {sorted.map((t) => <option key={t.teamId} value={t.teamId}>{t.cn}</option>)}
            </select>
          </div>
          <div className="field">
            <label>赛程场次</label>
            <select
              value={gameId ?? ''}
              onChange={(e) => setGameId(e.target.value || null)}
              style={{ minWidth: 216 }}
            >
              <option value="">不指定（中性休息状态）</option>
              {matchups.map((g) => (
                <option key={g.gameId} value={g.gameId}>
                  {fmtDate(g.date)} · {g.awayAbbr} @ {g.homeAbbr}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>&nbsp;</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 0' }}>
              <input type="checkbox" checked={neutral} onChange={(e) => setNeutral(e.target.checked)} />
              <span style={{ fontSize: 12.5 }}>中立场</span>
            </label>
          </div>
          <div className="field" style={{ marginLeft: 'auto' }}>
            <label>&nbsp;</label>
            <button className="btn" onClick={() => setShowParams((v) => !v)}>
              {showParams ? '收起参数' : '模型参数'}
            </button>
          </div>
        </div>

        {showParams && (
          <>
            <div className="divider" />
            <ParamPanel meta={meta} params={params} setParams={setParams} />
          </>
        )}
      </div>

      <ErrorBox error={error} />

      {!result ? <Loading /> : (
        <>
          <div className="card">
            <div className="matchup">
              <div className="side">
                <TeamLogo team={away} size={62} />
                <div className="nm">{away.cn}</div>
                <div className="rec">{away.wins}-{away.losses} · 客场</div>
                <div className="score" style={{ color: result.margin < 0 ? 'var(--text)' : 'var(--text-dim)' }}>
                  {result.awayScore.toFixed(0)}
                </div>
              </div>
              <div className="vs">
                <div>VS</div>
                {selectedGame && (
                  <div style={{ marginTop: 8, fontSize: 11.5 }}>
                    {fmtDate(selectedGame.date)}<br />
                    <span className="dim">{selectedGame.arena}</span>
                  </div>
                )}
              </div>
              <div className="side">
                <TeamLogo team={home} size={62} />
                <div className="nm">{home.cn}</div>
                <div className="rec">{home.wins}-{home.losses} · {neutral ? '中立' : '主场'}</div>
                <div className="score" style={{ color: result.margin > 0 ? 'var(--text)' : 'var(--text-dim)' }}>
                  {result.homeScore.toFixed(0)}
                </div>
              </div>
            </div>

            {result.pregame && (
              <div className="note" style={{ marginTop: 14, textAlign: 'center' }}>
                <span className="chip">终</span>{' '}
                实际 <b className="mono">{away.abbr} {result.actual.awayScore} - {result.actual.homeScore} {home.abbr}</b>
                {' · '}
                <span className={`chip ${result.hit ? 'hit' : 'miss'}`}>{result.hit ? '✓ 赛前预测猜对胜方' : '✗ 赛前预测猜错胜方'}</span>
                <br />
                这场已经打完。下面是用开打前的评级重算的赛前预测（与赛程页一致），不套用缺阵勾选。
              </div>
            )}

            <div style={{ marginTop: 18 }}>
              <div className="split-bar">
                <div style={{ width: `${result.awayWinProb * 100}%`, background: away.color, color: inkOn(away.color) }}>
                  {(result.awayWinProb * 100).toFixed(1)}%
                </div>
                <div style={{ width: `${result.homeWinProb * 100}%`, background: home.color, color: inkOn(home.color) }}>
                  {(result.homeWinProb * 100).toFixed(1)}%
                </div>
              </div>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                fontSize: 10.5, color: 'var(--text-faint)', marginTop: 5,
              }}
              >
                <span>{away.abbr} 获胜概率</span>
                <span>{home.abbr} 获胜概率</span>
              </div>
            </div>

            <div className="grid cols-4" style={{ marginTop: 16 }}>
              <StatTile label="预期分差" value={signed(result.margin)} hint="正数表示主队领先" />
              <StatTile
                label="主队让分"
                value={result.spread > 0 ? `+${result.spread}` : `${result.spread}`}
                hint="博彩口径：负数表示主队让分"
              />
              <StatTile label="预计总分" value={num(result.total, 1)} />
              <StatTile
                label="休息状态"
                value={`${restLabel(result.restAway)} / ${restLabel(result.restHome)}`}
                hint="客队 / 主队"
              />
            </div>

            {result.market && (
              <div style={{ marginTop: 16 }}>
                <MarketCompare
                  market={result.market}
                  prediction={result}
                  home={home}
                  away={away}
                />
              </div>
            )}
          </div>

          <div className="grid cols-2">
            <div className="card">
              <h2>分差来源拆解 <span className="sub">合计 {signed(result.margin)} 分</span></h2>
              <FactorChart factors={result.factors} />
              <div className="divider" />
              <DataTable
                rows={[
                  { k: '综合实力（每场净胜分）', h: result.strength.home.total, a: result.strength.away.total },
                  { k: 'Elo 折算', h: result.strength.home.eloPts, a: result.strength.away.eloPts },
                  { k: '净效率折算', h: result.strength.home.netPts, a: result.strength.away.netPts },
                  { k: '阵容更迭', h: result.strength.home.turnoverAdj, a: result.strength.away.turnoverAdj },
                  { k: '缺阵修正', h: result.strength.home.rosterAdj, a: result.strength.away.rosterAdj },
                  { k: '进攻效率', h: home.adv.offRtg, a: away.adv.offRtg },
                  { k: '防守效率', h: home.adv.defRtg, a: away.adv.defRtg },
                  { k: '节奏', h: home.adv.pace, a: away.adv.pace },
                  { k: '真实命中率 %', h: home.adv.tsPct * 100, a: away.adv.tsPct * 100 },
                ]}
                rowKey={(r) => r.k}
                initialSort={{ key: 'k', dir: 'asc' }}
                columns={[
                  { key: 'k', label: '指标', align: 'left', width: 176 },
                  { key: 'a', label: `${away.abbr} 客`, width: 76, render: (r) => num(r.a, 2) },
                  { key: 'h', label: `${home.abbr} 主`, width: 76, render: (r) => num(r.h, 2) },
                  {
                    key: 'd', label: '主-客', width: 76,
                    value: (r) => r.h - r.a,
                    render: (r) => <span className={signClass(r.h - r.a)}>{signed(r.h - r.a, 2)}</span>,
                  },
                ]}
              />
            </div>

            <div className="card">
              <h2>缺阵设置 <span className="sub">勾选后立即重新预测</span></h2>
              <div className="grid cols-2">
                <RosterPicker
                  team={away} roster={rosters[awayId]} out={out[awayId] ?? []}
                  onToggle={(pid) => toggleOut(awayId, pid)}
                />
                <RosterPicker
                  team={home} roster={rosters[homeId]} out={out[homeId] ?? []}
                  onToggle={(pid) => toggleOut(homeId, pid)}
                />
              </div>
              {(result.strength.home.missing.length > 0 || result.strength.away.missing.length > 0) && (
                <>
                  <div className="divider" />
                  <h2>缺阵影响</h2>
                  <DataTable
                    rows={[
                      ...result.strength.away.missing.map((m) => ({ ...m, team: away.abbr })),
                      ...result.strength.home.missing.map((m) => ({ ...m, team: home.abbr })),
                    ]}
                    rowKey={(r) => r.playerId}
                    initialSort={{ key: 'costPts', dir: 'asc' }}
                    columns={[
                      { key: 'team', label: '球队', align: 'left', width: 54 },
                      {
                        key: 'name', label: '球员', align: 'left', width: 172,
                        render: (r) => (
                          <span className="player-cell">
                            <PlayerHeadshot player={r} size={24} />
                            <span>{r.name}</span>
                          </span>
                        ),
                      },
                      { key: 'min', label: '场均时间', width: 72, render: (r) => num(r.min) },
                      { key: 'pie', label: 'PIE', width: 56, render: (r) => rate(r.pie) },
                      {
                        key: 'costPts', label: '实力损失', width: 72,
                        render: (r) => <span className="neg">{num(r.costPts, 2)}</span>,
                      },
                    ]}
                  />
                </>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function FactorChart({ factors }) {
  const max = Math.max(1, ...factors.map((f) => Math.abs(f.value)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {factors.map((f) => (
        <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
          <div style={{ width: 88, color: 'var(--text-dim)', flex: 'none' }}>{f.label}</div>
          <div style={{ flex: 1, display: 'flex', height: 15, alignItems: 'center' }}>
            <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
              {f.value < 0 && (
                <div style={{
                  width: `${(Math.abs(f.value) / max) * 100}%`, height: 13,
                  background: 'var(--bad)', borderRadius: '3px 0 0 3px', opacity: .9,
                  boxShadow: '0 0 10px var(--bad)',
                }}
                />
              )}
            </div>
            <div style={{ width: 1, height: 15, background: 'var(--line)' }} />
            <div style={{ flex: 1 }}>
              {f.value > 0 && (
                <div style={{
                  width: `${(Math.abs(f.value) / max) * 100}%`, height: 13,
                  background: 'var(--good)', borderRadius: '0 3px 3px 0', opacity: .9,
                  boxShadow: '0 0 10px var(--good)',
                }}
                />
              )}
            </div>
          </div>
          <div className={`mono ${signClass(f.value)}`} style={{ width: 52, textAlign: 'right' }}>
            {signed(f.value, 2)}
          </div>
        </div>
      ))}
      <div className="legend" style={{ marginTop: 3 }}>
        <span><i style={{ background: 'var(--good)' }} />利好主队</span>
        <span><i style={{ background: 'var(--bad)' }} />利好客队</span>
      </div>
    </div>
  );
}

function RosterPicker({ team, roster, out, onToggle }) {
  if (!team) return null;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <TeamLogo team={team} size={22} />
        <b style={{ fontSize: 12.5 }}>{team.cn}</b>
        {out.length > 0 && <span className="chip accent">{out.length} 人缺阵</span>}
      </div>
      {!roster ? <Loading text="加载名单…" /> : (
        <div className="scroll-y" style={{ maxHeight: 330, paddingRight: 4 }}>
          {roster.map((p) => (
            <label
              key={p.playerId}
              className="player-row"
              style={{
                padding: '3px 2px',
                borderBottom: '1px solid var(--line-2)',
                cursor: 'pointer',
                opacity: out.includes(p.playerId) ? 0.5 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={out.includes(p.playerId)}
                onChange={() => onToggle(p.playerId)}
              />
              <PlayerHeadshot player={p} size={24} />
              <span style={{
                flex: 1, fontSize: 12.5, minWidth: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
              >
                {p.name}
                <InjuryBadge injury={p.injury} />
              </span>
              <span className="dim mono" style={{ fontSize: 10.5 }}>{num(p.min, 0)}分</span>
              <span
                className="mono"
                title="缺阵时球队每场净胜分的变化"
                style={{
                  fontSize: 10.5, width: 38, textAlign: 'right',
                  color: p.outCostPts < -0.05 ? 'var(--warn)' : 'var(--text-faint)',
                }}
              >
                {p.outCostPts < -0.05 ? num(p.outCostPts, 1) : '≈0'}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function ParamPanel({ meta, params, setParams }) {
  const value = (k) => params[k] ?? meta.defaultParams[k];
  return (
    <div>
      <div className="grid cols-3">
        {PARAM_FIELDS.map((f) => (
          <div key={f.key} className="field">
            <label>{f.label} · <b className="mono">{num(value(f.key), 2)}</b></label>
            <input
              type="range"
              min={f.min} max={f.max} step={f.step}
              value={value(f.key)}
              onChange={(e) => setParams((p) => ({ ...p, [f.key]: Number(e.target.value) }))}
            />
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => setParams({})}>恢复默认</button>
        <label title="不读伤病名单。勾选后上季出场满 10 场的球员按场均分钟×70 场计入轮换，不勾按实际出场。" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <input
            type="checkbox"
            checked={!!params.assumeHealthy}
            onChange={(e) => setParams((p) => ({ ...p, assumeHealthy: e.target.checked ? 1 : 0 }))}
          />
          按满勤计权
        </label>
        <span className="note">参数为全站共享，会同时影响赛程页与赛季模拟。</span>
      </div>
    </div>
  );
}
