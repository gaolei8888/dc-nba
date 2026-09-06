import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../App.jsx';
import { api } from '../lib/api.js';
import {
  DataTable, TeamCell, StatTile, Loading, ErrorBox, Segmented,
} from '../components/common.jsx';
import { num, pct, signed, signClass } from '../lib/format.js';

const TABS = [
  { value: 'build', label: '造一个模型' },
  { value: 'errors', label: '模型错在哪' },
  { value: 'measure', label: '逐年测量' },
  { value: 'whatif', label: '反事实' },
];

/** 可调的模型参数。范围是根据回测里有意义的区间定的 */
const KNOBS = [
  { key: 'wElo', label: 'Elo 权重', min: 0, max: 1, step: 0.05, hint: '球队实力来自逐场结果迭代' },
  { key: 'wNet', label: '上赛季净效率权重', min: 0, max: 1, step: 0.05, hint: '回测显示这一项基本没用' },
  { key: 'inSeasonElo', label: '赛季中学习', min: 0, max: 1, step: 1, hint: '关掉它准确率会掉约 5 个百分点' },
  { key: 'homeAdv', label: '主场优势（分）', min: 0, max: 4, step: 0.1, hint: '实测近两季约 1.6' },
  { key: 'restWeight', label: '休息因素强度', min: 0, max: 3, step: 0.1, hint: '实测约 1.8' },
  { key: 'k', label: 'Elo 步长 K', min: 8, max: 40, step: 1, hint: '越大越快适应，也越容易被单场结果带偏' },
  { key: 'carryKeep', label: '赛季间保留比例', min: 0.4, max: 1, step: 0.05, hint: '新赛季保留多少上赛季实力' },
  { key: 'spreadSd', label: '分差标准差', min: 8, max: 16, step: 0.5, hint: '只影响概率，不影响胜负判断' },
];

export default function Lab() {
  const { teams, teamById, setAccent } = useApp();
  const [tab, setTab] = useState('build');
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => { setAccent(null); }, [setAccent]);
  useEffect(() => { api.labMeta().then(setMeta).catch(setError); }, []);

  if (error) return <ErrorBox error={error} />;
  if (!meta) return <Loading />;

  if (!meta.available) {
    return (
      <>
        <div className="page-head"><h1>模型实验室</h1></div>
        <div className="card">
          <p className="note">
            缺少回测数据集。先运行一次 <code>npm run backtest</code> 抓取历史赛季，
            再运行 <code>npm run ingest</code> 生成 <code>data/backtest.json</code>。
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>模型实验室</h1>
        <p>
          在 {meta.seasons.join('、')} 共 {meta.games} 场真实比赛上重放模型。
          每次重放都是无信息泄漏的——预测记录完成后才用真实结果更新评级。
        </p>
      </div>

      <div className="toolbar">
        <Segmented value={tab} onChange={setTab} options={TABS} />
      </div>

      {tab === 'build' && <BuildTab meta={meta} />}
      {tab === 'errors' && <ErrorsTab meta={meta} />}
      {tab === 'measure' && <MeasureTab meta={meta} />}
      {tab === 'whatif' && <WhatIfTab meta={meta} teams={teams} teamById={teamById} />}
    </>
  );
}

// ---------------------------------------------------------------- 造模型

function BuildTab({ meta }) {
  const [params, setParams] = useState(() => ({ ...meta.defaults }));
  const [result, setResult] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [board, setBoard] = useState([]);

  // 默认参数的成绩作为基准线
  useEffect(() => {
    api.labBacktest({ params: meta.defaults })
      .then((r) => { setBaseline(r); setResult(r); })
      .catch(setErr);
  }, [meta]);

  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.labBacktest({ params });
      setResult(r);
      setBoard((b) => {
        const entry = {
          id: JSON.stringify(params),
          params: { ...params },
          ...r.summary,
          at: Date.now(),
        };
        // 同一组参数只保留一条
        const rest = b.filter((x) => x.id !== entry.id);
        return [...rest, entry].sort((x, y) => y.accuracy - x.accuracy).slice(0, 12);
      });
    } catch (e) { setErr(e); }
    setBusy(false);
  };

  const changed = JSON.stringify(params) !== JSON.stringify(meta.defaults);

  return (
    <>
      <ErrorBox error={err} />

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <StatTile
          label="你的模型 · 命中率"
          value={result ? pct(result.summary.accuracy, 2) : '—'}
          hint={baseline ? `默认模型 ${pct(baseline.summary.accuracy, 2)}` : ''}
        />
        <StatTile
          label="Brier（越低越好）"
          value={result ? result.summary.brier.toFixed(4) : '—'}
          hint={baseline ? `默认模型 ${baseline.summary.brier.toFixed(4)}` : ''}
        />
        <StatTile
          label="分差平均误差"
          value={result ? `${result.summary.marginMae.toFixed(2)} 分` : '—'}
        />
        <StatTile
          label="分差偏置"
          value={result ? signed(result.summary.marginBias, 2) : '—'}
          hint="接近 0 才说明没有系统性高估或低估"
        />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>
            参数
            <span className="sub">改完点「回测」，在 {meta.games} 场真实比赛上打分</span>
          </h2>
          <div className="grid cols-2">
            {KNOBS.map((k) => (
              <div key={k.key} className="field">
                <label title={k.hint}>
                  {k.label} · <b className="mono">{num(params[k.key], 2)}</b>
                </label>
                <input
                  type="range"
                  min={k.min} max={k.max} step={k.step}
                  value={params[k.key]}
                  onChange={(e) => setParams((p) => ({ ...p, [k.key]: Number(e.target.value) }))}
                />
                <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{k.hint}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn primary" disabled={busy} onClick={run}>
              {busy ? '重放中…' : '回测这组参数'}
            </button>
            <button className="btn" disabled={!changed} onClick={() => setParams({ ...meta.defaults })}>
              恢复默认
            </button>
            <span className="note">一次重放约 {meta.games} 场，跑在工作线程里</span>
          </div>
        </div>

        <div className="card">
          <h2>你试过的模型 <span className="sub">按命中率排序</span></h2>
          {board.length === 0 ? (
            <div className="empty">还没有记录。调几个参数试试。</div>
          ) : (
            <DataTable
              rows={board}
              rowKey={(r) => r.id}
              initialSort={{ key: 'accuracy', dir: 'desc' }}
              onRowClick={(r) => setParams({ ...r.params })}
              columns={[
                {
                  key: 'accuracy', label: '命中率', width: 78,
                  render: (r) => <b className={baseline && r.accuracy > baseline.summary.accuracy ? 'pos' : ''}>{pct(r.accuracy, 2)}</b>,
                },
                { key: 'brier', label: 'Brier', width: 74, render: (r) => r.brier.toFixed(4) },
                { key: 'marginMae', label: '分差误差', width: 78, render: (r) => r.marginMae.toFixed(2) },
                {
                  key: 'marginBias', label: '偏置', width: 66,
                  render: (r) => <span className={Math.abs(r.marginBias) < 0.15 ? 'pos' : ''}>{signed(r.marginBias, 2)}</span>,
                },
                {
                  key: 'desc', label: '参数', align: 'left', width: 240,
                  value: () => 0,
                  render: (r) => (
                    <span className="dim" style={{ fontSize: 11 }}>
                      {KNOBS.filter((k) => r.params[k.key] !== meta.defaults[k.key])
                        .map((k) => `${k.label} ${num(r.params[k.key], 2)}`)
                        .join(' · ') || '默认参数'}
                    </span>
                  ),
                },
              ]}
            />
          )}
          <p className="note" style={{ marginTop: 10 }}>
            点任意一行可以把那组参数load回滑块。<br />
            <b>参考系</b>：永远选主队 55.6%，公开模型一般 65-68%，博彩盘口约 68-70%。
          </p>
        </div>
      </div>

      {result && (
        <div className="card">
          <h2>概率校准 <span className="sub">模型说 70% 的那些比赛，实际赢了多少</span></h2>
          <DataTable
            rows={result.calibration}
            rowKey={(r) => r.lo}
            initialSort={{ key: 'lo', dir: 'asc' }}
            columns={[
              { key: 'lo', label: '预测区间', width: 90, render: (r) => `${r.lo}–${r.hi}%` },
              { key: 'n', label: '场次', width: 70 },
              { key: 'predicted', label: '模型说', width: 80, render: (r) => pct(r.predicted, 1) },
              { key: 'actual', label: '实际是', width: 80, render: (r) => pct(r.actual, 1) },
              {
                key: 'gap', label: '偏差', width: 80,
                value: (r) => r.actual - r.predicted,
                render: (r) => {
                  const d = (r.actual - r.predicted) * 100;
                  return <span className={Math.abs(d) < 3 ? 'pos' : 'neg'}>{signed(d, 1)}</span>;
                },
              },
            ]}
          />
          <p className="note" style={{ marginTop: 10 }}>
            校准好的模型，「模型说」和「实际是」两列应该贴近。偏差持续为正说明模型过于保守，
            持续为负说明过于自信。
          </p>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- 误差分析

function ErrorsTab({ meta }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.labBacktest({ params: meta.defaults }).then(setData).catch(setErr);
  }, [meta]);

  if (err) return <ErrorBox error={err} />;
  if (!data) return <Loading text="重放中…" />;

  return (
    <>
      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <StatTile label="整体命中率" value={pct(data.summary.accuracy, 2)} />
        <StatTile label="整体 Brier" value={data.summary.brier.toFixed(4)} />
        <StatTile label="最难的一类" value={data.slices[0]?.label ?? '—'} />
        <StatTile label="最容易的一类" value={data.slices.at(-1)?.label ?? '—'} />
      </div>

      <div className="card">
        <h2>按比赛类型切片 <span className="sub">Brier 偏离为正 = 这类比赛模型更容易错</span></h2>
        <DataTable
          rows={data.slices}
          rowKey={(r) => r.label}
          initialSort={{ key: 'brierDelta', dir: 'desc' }}
          columns={[
            { key: 'label', label: '比赛类型', align: 'left', width: 190 },
            { key: 'n', label: '场次', width: 70 },
            { key: 'accuracy', label: '命中率', width: 78, render: (r) => pct(r.accuracy, 1) },
            { key: 'brier', label: 'Brier', width: 74, render: (r) => r.brier.toFixed(4) },
            {
              key: 'brierDelta', label: '相对整体', width: 96,
              render: (r) => (
                <span className={r.brierDelta > 0 ? 'neg' : 'pos'}>
                  {signed(r.brierDelta, 4)} {r.brierDelta > 0 ? '更难' : '更易'}
                </span>
              ),
            },
            {
              key: 'marginBias', label: '分差偏置', width: 86,
              render: (r) => <span className={signClass(-Math.abs(r.marginBias))}>{signed(r.marginBias, 2)}</span>,
            },
          ]}
        />
        <p className="note" style={{ marginTop: 10 }}>
          这不是"模型有 bug"的清单，而是**难度分布**：实力接近的比赛本来就难猜，
          模型没把握时它确实也不该有把握。真正值得警惕的是<b>分差偏置</b>——
          某一类比赛上持续偏向一边，说明模型对这类情况有系统性误判，是可以修的。
        </p>
      </div>

      <div className="card">
        <h2>逐赛季表现</h2>
        <DataTable
          rows={data.bySeason}
          rowKey={(r) => r.season}
          initialSort={{ key: 'season', dir: 'asc' }}
          columns={[
            { key: 'season', label: '赛季', align: 'left', width: 100 },
            { key: 'n', label: '场次', width: 70 },
            { key: 'accuracy', label: '命中率', width: 80, render: (r) => pct(r.accuracy, 2) },
            { key: 'brier', label: 'Brier', width: 78, render: (r) => r.brier.toFixed(4) },
            { key: 'marginMae', label: '分差误差', width: 82, render: (r) => r.marginMae.toFixed(2) },
            {
              key: 'marginBias', label: '分差偏置', width: 86,
              render: (r) => <span className={Math.abs(r.marginBias) < 0.2 ? 'pos' : 'neg'}>{signed(r.marginBias, 2)}</span>,
            },
          ]}
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- 逐年测量

function MeasureTab({ meta }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api.labMeasure({}).then(setData).catch(setErr); }, []);

  if (err) return <ErrorBox error={err} />;
  if (!data) return <Loading text="测量中…" />;

  const ha = data.homeAdvantage;
  const first = ha[0];
  const last = ha.at(-1);
  const hard = { 0: -1.1, 1: 0, 2: 0.35, 3: 0.5, 4: 0.5 };

  return (
    <>
      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <StatTile label={`${first?.season} 主场优势`} value={`${first?.homeAdvantage.toFixed(2)} 分`} />
        <StatTile label={`${last?.season} 主场优势`} value={`${last?.homeAdvantage.toFixed(2)} 分`} />
        <StatTile
          label="四年变化"
          value={signed((last?.homeAdvantage ?? 0) - (first?.homeAdvantage ?? 0), 2)}
          hint="主场优势在持续下降，这是 NBA 近年公认的现象"
        />
        <StatTile label="模型当前采用" value={`${meta.defaults.homeAdv} 分`} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>主场优势逐年测量 <span className="sub">让分差偏置归零的那个值</span></h2>
          <DataTable
            rows={ha}
            rowKey={(r) => r.season}
            initialSort={{ key: 'season', dir: 'asc' }}
            columns={[
              { key: 'season', label: '赛季', align: 'left', width: 96 },
              { key: 'n', label: '场次', width: 70 },
              {
                key: 'homeAdvantage', label: '主场优势', width: 110,
                render: (r) => (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span className="mono" style={{ width: 40, textAlign: 'right' }}>{r.homeAdvantage.toFixed(2)}</span>
                    <span style={{
                      display: 'inline-block', height: 7, borderRadius: 4,
                      width: `${Math.max(2, r.homeAdvantage * 22)}px`,
                      background: 'var(--team-raw)',
                    }}
                    />
                  </span>
                ),
              },
              { key: 'homeWinPct', label: '主场胜率', width: 88, render: (r) => pct(r.homeWinPct, 1) },
            ]}
          />
          <p className="note" style={{ marginTop: 10 }}>
            这个测量直接改进了模型：原来写死的 2.4 分是 2022-23 的水平，
            导致最近两个赛季系统性高估主队（分差偏置 +0.79）。改成 1.6 之后偏置归零。
          </p>
        </div>

        <div className="card">
          <h2>休息天数的真实收益 <span className="sub">实测 vs 模型里写的</span></h2>
          <DataTable
            rows={data.rest.map((r) => ({ ...r, hard: hard[r.days] ?? 0.5 }))}
            rowKey={(r) => r.days}
            initialSort={{ key: 'days', dir: 'asc' }}
            columns={[
              {
                key: 'days', label: '休息', align: 'left', width: 88,
                render: (r) => (r.days === 0 ? <span className="neg">背靠背</span> : `休 ${r.days} 天`),
              },
              { key: 'n', label: '样本', width: 74 },
              {
                key: 'effect', label: '实测效应', width: 90,
                render: (r) => <b className={signClass(r.effect)}>{signed(r.effect, 2)} 分</b>,
              },
              {
                key: 'hard', label: '表里写的', width: 84,
                render: (r) => <span className="dim">{signed(r.hard, 2)}</span>,
              },
              {
                key: 'ratio', label: '低估倍数', width: 84,
                value: (r) => (r.hard ? Math.abs(r.effect / r.hard) : 0),
                render: (r) => (r.hard
                  ? <span className="mono">{(r.effect / r.hard).toFixed(2)}×</span>
                  : <span className="dim">—</span>),
              },
            ]}
          />
          <p className="note" style={{ marginTop: 10 }}>
            表的<b>形状</b>是对的（背靠背是惩罚、多休息是收益、三天以后见顶），
            但<b>幅度</b>普遍估小了约 1.8 倍。背靠背实测 −1.98 分，原来写的是 −1.1。
          </p>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- 反事实

function WhatIfTab({ meta, teams, teamById }) {
  const sorted = useMemo(() => [...teams].sort((a, b) => a.cn.localeCompare(b.cn, 'zh')), [teams]);
  const [teamId, setTeamId] = useState(sorted[0]?.teamId);
  const [season, setSeason] = useState(meta.seasons.at(-1));
  const [delta, setDelta] = useState(3);
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const run = async () => {
    setBusy(true); setErr(null);
    try {
      setRes(await api.labCounterfactual({ teamId, deltaPts: delta, seasons: [season] }));
    } catch (e) { setErr(e); }
    setBusy(false);
  };

  useEffect(() => { run(); /* eslint-disable-next-line */ }, [teamId, season, delta]);

  const team = teamById.get(teamId);

  return (
    <>
      <ErrorBox error={err} />
      <div className="card">
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <div className="field">
            <label>球队</label>
            <select value={teamId} onChange={(e) => setTeamId(Number(e.target.value))} style={{ minWidth: 168 }}>
              {sorted.map((t) => <option key={t.teamId} value={t.teamId}>{t.cn}</option>)}
            </select>
          </div>
          <div className="field">
            <label>赛季</label>
            <select value={season} onChange={(e) => setSeason(e.target.value)}>
              {meta.seasons.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 240 }}>
            <label>假如这支球队全季强 / 弱 <b className="mono">{signed(delta, 1)}</b> 分</label>
            <input
              type="range" min="-8" max="8" step="0.5"
              value={delta}
              onChange={(e) => setDelta(Number(e.target.value))}
            />
          </div>
        </div>
      </div>

      {!res ? <Loading text={busy ? '重放整个赛季…' : '加载中…'} /> : (
        <>
          <div className="grid cols-4" style={{ marginBottom: 14 }}>
            <div className="tile">
              <div className="k">球队</div>
              <div style={{ marginTop: 7 }}>
                <TeamCell team={team} size={28} showAbbr={false} />
              </div>
            </div>
            <StatTile label="真实评级下的期望胜场" value={res.baseExpectedWins} unit={` / ${res.n}`} />
            <StatTile
              label={`强/弱 ${signed(delta, 1)} 分之后`}
              value={res.altExpectedWins}
              unit={` / ${res.n}`}
            />
            <StatTile
              label="胜场变化"
              value={signed(res.winsDelta, 1)}
              hint={`${res.flippedGames} 场比赛的预测胜负方向被改变`}
            />
          </div>

          <div className="card">
            <h2>换算关系</h2>
            <p className="note">
              {team?.cn} 在 {season} 赛季，每 1 分净胜分约合{' '}
              <b>{delta ? Math.abs(res.winsDelta / delta).toFixed(2) : '—'}</b> 个胜场。
              公认的经验法则是 2.7 —— 这是我们用自己的数据独立测出来的，落在同一量级。
            </p>
            <div className="divider" />
            <p className="note">
              <b>这个结果要这样读</b>：它是「模型认为会怎样」，不是「历史真的会怎样」。
              我们改的是模型对这支球队的评级，不是真实比赛结果——真实结果无法反事实。
              把它当成「这么大的实力差距，在这份赛程下值多少胜场」的换算器，
              而不是平行宇宙的预言。<br />
              重放是全季持续的：加成加在每一场的实力计算里，而不是只在开赛日调一次评级
              （那样会被赛季中的滚动更新冲掉，+3 分只剩 +2.4 胜）。
            </p>
          </div>
        </>
      )}
    </>
  );
}
