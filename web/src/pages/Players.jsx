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
  // 默认门槛随赛季进度：本季取出场最少球队的已赛场次（封顶 20），上季数据仍为 20；用户改过就以用户为准
  const [userMinGp, setMinGp] = useState(null);
  const minGp = userMinGp ?? (meta.displayCurrent ? Math.min(20, ...teams.map((t) => t.wins + t.losses)) : 20);
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
          {(meta.displayCurrent ? meta.targetSeason : meta.priorSeason)} 赛季场均基础数据与高阶数据，共 {all.length} 人；
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
 * IMP 的验证成绩。
 *
 * 验收标准是「用第 N 季的数据预测第 N+1 季的真实表现」——不是同赛季。
 * 同赛季的比法有两个毛病：IMP 里含当季 APM，等于拿目标的一部分预测目标；
 * 而且不对题，这个应用本来就是拿上赛季预测下赛季。
 *
 * 把各个候选指标一起列出来，包括 IMP 输的那些格子。
 * 「对标盘口」那页也是这么处理自己的短处的——只报好数字的指标不值得信。
 */
export function ImpactValidation({ impact }) {
  const v = impact?.validation;
  if (!v?.perPair?.length) return null;
  const names = v.candidates ?? Object.keys(v.average ?? {});
  const avg = v.average ?? {};
  const best = (row) => Math.max(...names.map((n) => row[n] ?? -9));
  const wins = v.perPair.filter((row) => (row.IMP ?? -9) >= best(row)).length;

  return (
    <div className="card">
      <h2>
        IMP 准不准
        <span className="sub">{v.criterion}</span>
      </h2>

      <div className="grid cols-3" style={{ marginBottom: 12 }}>
        <StatTile
          abbr="IMP" label="平均相关" value={(avg.IMP ?? 0).toFixed(3)}
          hint="用第 N 季的数据预测第 N+1 季真实表现的相关系数"
        />
        <StatTile
          abbr="PIE" label="同一批球员" value={(avg.PIE ?? 0).toFixed(3)}
          hint="现状指标 PIE 在同一批球员上的成绩"
        />
        <StatTile
          abbr="W" label="逐季排第一" value={`${wins} / ${v.perPair.length}`}
          hint="有多少个赛季对里，IMP 在所有候选指标中排第一"
        />
      </div>

      <DataTable
        rows={v.perPair}
        rowKey={(r) => r.pair}
        initialSort={{ key: 'pair', dir: 'asc' }}
        columns={[
          { key: 'pair', label: '赛季对', align: 'left', width: 132 },
          { key: 'n', label: '人数', width: 58 },
          ...names.map((n) => ({
            key: n,
            label: n === 'IMP' ? <Th abbr="IMP" cn="混合" /> : n,
            title: n,
            width: n === 'IMP' ? 76 : 112,
            render: (r) => {
              const val = r[n];
              if (val === null || val === undefined) return <span className="dim">—</span>;
              const isBest = val >= best(r);
              return isBest ? <b className="pos">{val.toFixed(3)}</b> : val.toFixed(3);
            },
          })),
        ]}
      />

      <p className="note" style={{ marginTop: 10 }}>
        IMP 是<b>统计栏模型（SPM）</b>与<b>场上实测（APM）</b>的混合，两半各占
        {' '}{Math.round((1 - (impact.blendW ?? 0.35)) * 100)}% 与
        {' '}{Math.round((impact.blendW ?? 0.35) * 100)}%。
        单看任何一半都更差——这一点表里就能看到。混合权重是扫出来的，
        而且用了两把尺子：预测次季 APM，以及预测次季 on/off。
        只用前者不行，因为 IMP 里含 APM，两者共享同一个偏差。
      </p>
      {v.shrink && (
        <p className="note">
          混合之后再<b>按上季出场分钟向人群均值收缩</b>（k = {v.shrink.k} 分钟）：
          打满 {v.shrink.pivot} 分钟的人不变，480 分钟的人只保留约四成偏离——
          上场时间本身就说明了教练怎么看他。表里「IMP」是收缩后的线上口径，
          「IMP（收缩前）」照列作对照。k 是留一赛季对选的，4 折都选了同一个值；
          次季 on/off 这把尺子上收缩也 4 对全胜，只是有两对的增量接近噪声。
        </p>
      )}
      <p className="note">
        做法对齐 EPM 的公开方法，但 EPM 用的是逐回合、含对手阵容的完整 RAPM，
        我们实测那一半只看得到进攻方五人，算出来的是<b>未做对手调整</b>的 APM。
        后果是<b>总在一起上场的球员分不太开</b>——某支强队的角色球员会被抬高，
        榜单上还能看到这个痕迹。这是当前最大的已知缺陷。
      </p>
      <p className="note">
        这条不再是猜测：我们解析了 5 个赛季 6150 场的 play-by-play，还原出攻守双方
        阵容做了真 RAPM，量到污染确实存在（球员评分与所在队净效率的相关
        <b> 0.589 → 0.425</b>）。但换上去之后预测能力<b>测不出改善</b>
        （配对 t=1.45，不显著），所以没有为它增加一条每次刷新要重抓 3 小时的管线。
        这不等于 RAPM 更差——是我们每季约 24 万回合的数据量分辨不出来；
        EPM 有 550 万回合。
      </p>
    </div>
  );
}
