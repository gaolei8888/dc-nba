import React, { useEffect, useMemo, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api } from '../lib/api.js';
import {
  TeamCell, PlayerHeadshot, Loading, ErrorBox, Segmented, StatTile, DataTable, Th,
} from '../components/common.jsx';
import PlayerTable, { MODE_OPTIONS, MODE_LABEL } from '../components/PlayerTable.jsx';
import { num, rate } from '../lib/format.js';

const POS_FILTERS = [
  { value: 'all', label: '全部位置' },
  { value: 'G', label: '后卫' },
  { value: 'F', label: '前锋' },
  { value: 'C', label: '中锋' },
];

export default function Players() {
  const { teams, teamById, meta, setAccent } = useApp();
  const [all, setAll] = useState(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('base');
  const [q, setQ] = useState('');
  const [teamFilter, setTeamFilter] = useState('all');
  const [posFilter, setPosFilter] = useState('all');
  const [minGp, setMinGp] = useState(20);
  const [rosterOnly, setRosterOnly] = useState(true);

  useEffect(() => { setAccent(null); }, [setAccent]);

  useEffect(() => {
    api.players().then(setAll).catch(setError);
  }, []);

  // 选中某支球队时，整站配色跟着走
  useEffect(() => {
    setAccent(teamFilter === 'all' ? null : teamById.get(Number(teamFilter)) ?? null);
  }, [teamFilter, teamById, setAccent]);

  const rows = useMemo(() => {
    if (!all) return [];
    const kw = q.trim().toLowerCase();
    return all.filter((p) => {
      if (rosterOnly && !p.onRoster) return false;
      if (teamFilter !== 'all' && p.teamId !== Number(teamFilter)) return false;
      if (posFilter !== 'all' && !(p.pos ?? '').includes(posFilter)) return false;
      if ((p.gp ?? 0) < minGp) return false;
      if (kw && !p.name.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [all, q, teamFilter, posFilter, minGp, rosterOnly]);

  if (error) return <ErrorBox error={error} />;
  if (!all) return <Loading />;

  const leader = (get) => [...rows].sort((a, b) => (get(b) ?? -99) - (get(a) ?? -99))[0];
  const topScorer = leader((p) => p.base?.pts);
  const topPie = leader((p) => p.adv?.pie);
  const topImpact = [...rows].sort((a, b) => (a.outCostPts ?? 0) - (b.outCostPts ?? 0))[0];

  return (
    <>
      <div className="page-head">
        <h1>球员数据</h1>
        <p>
          {meta.priorSeason} 赛季场均基础数据与高阶数据，共 {all.length} 人；
          名单归属已按 {meta.targetSeason} 最新阵容更新。
        </p>
      </div>

      <div className="toolbar">
        <div className="field">
          <label>搜索</label>
          <input
            type="search"
            placeholder="球员姓名"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ minWidth: 170 }}
          />
        </div>
        <div className="field">
          <label>球队</label>
          <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} style={{ minWidth: 150 }}>
            <option value="all">全部球队</option>
            {[...teams].sort((a, b) => a.cn.localeCompare(b.cn, 'zh')).map((t) => (
              <option key={t.teamId} value={t.teamId}>{t.cn}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>位置</label>
          <select value={posFilter} onChange={(e) => setPosFilter(e.target.value)}>
            {POS_FILTERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label>最少出场</label>
          <input
            type="number" min="0" max="82" value={minGp}
            onChange={(e) => setMinGp(Number(e.target.value) || 0)}
            style={{ width: 84 }}
          />
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 0' }}>
            <input type="checkbox" checked={rosterOnly} onChange={(e) => setRosterOnly(e.target.checked)} />
            <span style={{ fontSize: 12.5 }}>仅现役名单</span>
          </label>
        </div>
        <div className="field" style={{ marginLeft: 'auto' }}>
          <label>&nbsp;</label>
          <Segmented
            value={mode}
            onChange={setMode}
            options={MODE_OPTIONS}
          />
        </div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <StatTile label="筛选结果" value={rows.length} unit=" 人" />
        <PlayerTile label="得分王" player={topScorer} value={topScorer && `${num(topScorer.base?.pts)} 分`} />
        <PlayerTile label="PIE 最高" player={topPie} value={topPie && rate(topPie.adv?.pie)} />
        <PlayerTile
          label="缺阵影响最大"
          player={topImpact}
          value={topImpact && `${num(topImpact.outCostPts, 1)} 分/场`}
        />
      </div>

      {mode === 'adv' && <ImpactValidation impact={meta.impact} />}

      <div className="card">
        <h2>
          {MODE_LABEL[mode]}数据
          <span className="sub">点击表头排序 · 点击行进入所属球队</span>
        </h2>
        <PlayerTable
          rows={rows}
          mode={mode}
          maxHeight={640}
          onRowClick={(p) => go(`team/${p.teamId}`)}
          nameColumn={{
            key: 'name', label: '球员', align: 'left', width: 216,
            render: (p) => (
              <span className="player-cell">
                <PlayerHeadshot player={p} size={28} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {p.name}
                  {p.priorTeamAbbr && p.priorTeamAbbr !== p.teamAbbr && (
                    <span className="chip accent" style={{ marginLeft: 6 }}>转自 {p.priorTeamAbbr}</span>
                  )}
                </span>
              </span>
            ),
          }}
          extraColumns={[
            {
              key: 'teamAbbr', label: '球队', align: 'left', width: 142,
              render: (p) => <TeamCell team={teamById.get(p.teamId)} size={20} showAbbr={false} />,
            },
            { key: 'posCn', label: '位置', align: 'left', width: 72, render: (p) => <span className="dim">{p.posCn || '—'}</span> },
            { key: 'age', label: '年龄', width: 44, render: (p) => num(p.age, 0) },
          ]}
        />
      </div>
    </>
  );
}

/** 带头像的球员数据块 */
function PlayerTile({ label, player, value }) {
  if (!player) return <StatTile label={label} value="—" />;
  return (
    <div className="tile">
      <div className="k">{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 7 }}>
        <PlayerHeadshot player={player} size={34} />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontWeight: 700, fontSize: 14, letterSpacing: '-.2px',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >
            {player.name}
          </div>
          <div className="mono" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            {player.teamAbbr} · {value}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * IMP 的验证成绩，**把输的那两年一起摆出来**。
 *
 * 一个只报好数字的指标不值得信。个人层面 IMP 五个赛季全胜、幅度也大，
 * 这个结论很硬；但球队层面只有 3 胜 2 负，而且输的其中一年是最新赛季——
 * 只看界面的人会以为 IMP 全面优于 PIE，实际情况更微妙。
 * 「对标盘口」那页用同样的方式处理过自己的短处，这里保持一致。
 */
export function ImpactValidation({ impact }) {
  if (!impact?.validation) return null;
  const { individual = [], team = [] } = impact.validation;
  if (!individual.length) return null;

  const avg = (rows, key) => rows.reduce((s, r) => s + r[key], 0) / rows.length;
  const teamWins = team.filter((r) => r.imp >= r.pie).length;
  const teamLosses = team.length - teamWins;
  const lostSeasons = team.filter((r) => r.imp < r.pie).map((r) => r.season);

  return (
    <div className="card">
      <h2>
        IMP 准不准
        <span className="sub">留出一个赛季验证，训练时看不到它</span>
      </h2>

      <div className="grid cols-3" style={{ marginBottom: 12 }}>
        <StatTile
          abbr="IMP" label="个人层面相关" value={avg(individual, 'impApm').toFixed(3)}
          hint="在留出赛季上，与该球员真实 APM 的相关系数"
        />
        <StatTile
          abbr="PIE" label="同一批比赛" value={avg(individual, 'pieApm').toFixed(3)}
          hint="现状指标 PIE 在同一批球员上的相关系数"
        />
        <StatTile
          abbr="W-L" label="球队层面战绩" value={`${teamWins} 胜 ${teamLosses} 负`}
          hint="分钟加权聚合后还原球队净效率，与 PIE 逐赛季比较"
        />
      </div>

      <DataTable
        rows={individual.map((r) => {
          const t = team.find((x) => x.season === r.season) ?? {};
          return { ...r, teamImp: t.imp ?? null, teamPie: t.pie ?? null };
        })}
        rowKey={(r) => r.season}
        initialSort={{ key: 'season', dir: 'asc' }}
        columns={[
          { key: 'season', label: '留出赛季', align: 'left', width: 86 },
          { key: 'n', label: '人数', width: 58 },
          {
            key: 'impApm', label: <Th abbr="IMP" cn="个人相关" />, title: '个人层面：IMP 与真实 APM 的相关',
            width: 82, render: (r) => <b>{r.impApm.toFixed(3)}</b>,
          },
          {
            key: 'pieApm', label: <Th abbr="PIE" cn="个人相关" />, title: '个人层面：PIE 与真实 APM 的相关',
            width: 82, render: (r) => r.pieApm.toFixed(3),
          },
          {
            key: 'teamImp', label: <Th abbr="IMP" cn="球队 R²" />, title: '球队层面：IMP 还原球队净效率',
            width: 82,
            render: (r) => (r.teamImp === null ? <span className="dim">—</span> : (
              <b className={r.teamImp >= r.teamPie ? 'pos' : 'neg'}>{r.teamImp.toFixed(3)}</b>
            )),
          },
          {
            key: 'teamPie', label: <Th abbr="PIE" cn="球队 R²" />, title: '球队层面：PIE 还原球队净效率',
            width: 82,
            render: (r) => (r.teamPie === null ? <span className="dim">—</span> : r.teamPie.toFixed(3)),
          },
        ]}
      />

      <p className="note" style={{ marginTop: 10 }}>
        <b>个人层面 IMP 五个赛季全胜</b>（平均 {avg(individual, 'impApm').toFixed(3)} 对
        PIE 的 {avg(individual, 'pieApm').toFixed(3)}），这个结论是硬的。
        <b> 但球队层面只有 {teamWins} 胜 {teamLosses} 负</b>
        {lostSeasons.length > 0 && <>，输的是 {lostSeasons.join('、')}</>}。
        把 IMP 按分钟加权求和去还原球队净效率时，它并不总是比 PIE 好——
        PIE 本来就是"球队全部可统计事件里占多少份额"，天生就该加得回球队表现，
        这个比法对它有利。两项一起看才是完整的：
        <b>IMP 更适合评价个人，PIE 更适合加总成球队。</b>
      </p>
      <p className="note">
        指标做法与 EPM 的公开方法一致（box + 追踪回归到阵容级 APM），
        但 EPM 用的是逐回合、含对手阵容的完整 RAPM，我们只有球队自己的五人组合数据，
        算出来的是<b>未做对手调整</b>的 APM。这个差别对出场少、对手分布不均的球员影响更大。
      </p>
    </div>
  );
}
