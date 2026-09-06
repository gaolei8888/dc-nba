import React, { useEffect, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api } from '../lib/api.js';
import { DataTable, TeamCell, StatTile, Loading, ErrorBox, Segmented } from '../components/common.jsx';
import { num, signed, signClass, pct100, probColor } from '../lib/format.js';

export default function Simulate() {
  const { meta, teamById, out, params } = useApp();
  const [sims, setSims] = useState(3000);
  const [conf, setConf] = useState('all');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);

  const run = (n = sims) => {
    setRunning(true);
    setError(null);
    api.simulate({ sims: n, out, params })
      .then(setData)
      .catch(setError)
      .finally(() => setRunning(false));
  };

  useEffect(() => { run(); /* eslint-disable-next-line */ }, [out, params]);

  const rows = (data?.teams ?? []).filter((t) => conf === 'all' || t.conference === conf);

  return (
    <>
      <div className="page-head">
        <h1>赛季模拟</h1>
        <p>
          对 {meta.targetSeason} 赛季 1200 场常规赛做蒙特卡洛模拟，逐场按预测胜率抽样，
          并对每支球队叠加赛季实力不确定性，得到战绩分布与晋级概率。
        </p>
      </div>

      <div className="toolbar">
        <div className="field">
          <label>模拟次数</label>
          <select value={sims} onChange={(e) => setSims(Number(e.target.value))}>
            {[1000, 3000, 5000, 10000].map((n) => <option key={n} value={n}>{n.toLocaleString()} 次</option>)}
          </select>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <button className="btn primary" disabled={running} onClick={() => run()}>
            {running ? '模拟中…' : '重新模拟'}
          </button>
        </div>
        <div className="field" style={{ marginLeft: 'auto' }}>
          <label>&nbsp;</label>
          <Segmented
            value={conf}
            onChange={setConf}
            options={[
              { value: 'all', label: '全联盟' },
              { value: 'East', label: '东部' },
              { value: 'West', label: '西部' },
            ]}
          />
        </div>
      </div>

      <ErrorBox error={error} />

      {!data ? <Loading text="正在模拟赛季…" /> : (
        <>
          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            <StatTile label="模拟次数" value={data.sims.toLocaleString()} unit=" 次" />
            <StatTile label="耗时" value={data.ms} unit=" ms" />
            <StatTile
              label="最佳战绩热门"
              value={[...data.teams].sort((a, b) => b.bestRecordPct - a.bestRecordPct)[0].cn}
              unit={`  ${pct100([...data.teams].sort((a, b) => b.bestRecordPct - a.bestRecordPct)[0].bestRecordPct, 0)}`}
            />
            <StatTile
              label="预计 50 胜以上"
              value={data.teams.filter((t) => t.projWins >= 50).length}
              unit=" 队"
            />
          </div>

          <div className="card">
            <h2>
              {conf === 'all' ? '全联盟' : conf === 'East' ? '东部' : '西部'}战绩预测
              <span className="sub">胜场区间为 5%~95% 分位数</span>
            </h2>
            <DataTable
              rows={rows}
              rowKey={(t) => t.teamId}
              initialSort={{ key: 'projWins', dir: 'desc' }}
              onRowClick={(t) => go(`team/${t.teamId}`)}
              columns={[
                {
                  key: 'cn', label: '球队', align: 'left', width: 200,
                  render: (t) => <TeamCell team={teamById.get(t.teamId)} />,
                },
                { key: 'conference', label: '分区', width: 56, render: (t) => (t.conference === 'East' ? '东部' : '西部') },
                {
                  key: 'strength', label: '实力', width: 70,
                  render: (t) => <span className={signClass(t.strength)}>{signed(t.strength, 1)}</span>,
                },
                {
                  key: 'projWins', label: '预计战绩', width: 100,
                  render: (t) => <b className="mono">{t.projWins.toFixed(1)}-{t.projLosses.toFixed(1)}</b>,
                },
                {
                  key: 'range', label: '胜场区间', width: 140,
                  value: (t) => t.winsHi - t.winsLo,
                  render: (t) => <WinRange lo={t.winsLo} hi={t.winsHi} mid={t.projWins} />,
                },
                {
                  key: 'playoffPct', label: '直接晋级', title: '分区前 6', width: 86,
                  render: (t) => <Prob v={t.playoffPct} />,
                },
                {
                  key: 'playinPct', label: '附加赛', title: '分区 7-10 名', width: 76,
                  render: (t) => <Prob v={t.playinPct} />,
                },
                {
                  key: 'postseasonPct', label: '进入季后赛圈', width: 100,
                  render: (t) => <Prob v={t.postseasonPct} />,
                },
                {
                  key: 'topSeedPct', label: '分区头名', width: 86,
                  render: (t) => <Prob v={t.topSeedPct} />,
                },
                {
                  key: 'bestRecordPct', label: '联盟第一', width: 86,
                  render: (t) => <Prob v={t.bestRecordPct} />,
                },
              ]}
            />
          </div>

          <div className="card">
            <h2>说明</h2>
            <p className="note">
              每次模拟中，先给每支球队抽一个标准差 {num(params.seasonNoiseSd ?? meta.defaultParams.seasonNoiseSd, 1)} 分的实力扰动
              （代表赛季前评估本身的误差：新援磨合、伤病、球员成长等），再逐场按胜率抽样决定胜负。<br />
              「直接晋级」为分区前 6，「附加赛」为分区 7-10 名。同战绩情况按随机顺序打破平局，未实现联盟的具体平局规则。<br />
              模型基于 {meta.priorSeason} 赛季数据，未包含选秀新秀、夏窗签约球员的产能预估——
              在球队页把伤停或已离队球员标记为缺阵，可以让结果更贴近你的判断。
            </p>
          </div>
        </>
      )}
    </>
  );
}

function Prob({ v }) {
  return (
    <span className="mono" style={{ color: v >= 50 ? probColor(v / 100) : 'var(--text-dim)' }}>
      {v.toFixed(1)}%
    </span>
  );
}

/** 胜场区间条：40~65 胜映射到整条宽度 */
function WinRange({ lo, hi, mid }) {
  const min = 10;
  const max = 72;
  const x = (v) => ((v - min) / (max - min)) * 100;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%' }}>
      <span style={{ position: 'relative', flex: 1, height: 8, background: 'var(--bg-3)', borderRadius: 4, minWidth: 70 }}>
        <span style={{
          position: 'absolute', left: `${x(lo)}%`, width: `${x(hi) - x(lo)}%`,
          top: 0, bottom: 0, background: 'rgba(88,166,255,.4)', borderRadius: 4,
        }} />
        <span style={{
          position: 'absolute', left: `${x(mid)}%`, width: 2, top: -2, bottom: -2,
          background: 'var(--accent)',
        }} />
      </span>
      <span className="mono dim" style={{ fontSize: 11, width: 44 }}>{lo}-{hi}</span>
    </span>
  );
}
