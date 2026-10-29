import React from 'react';
import { useI18n } from '../i18n/react.jsx';
import { StatTile } from './common.jsx';

// 假骨架的灰条宽度（百分比）：固定值，保证每次渲染一样
const BARS = [92, 78, 85, 64, 88, 71];

/**
 * 被锁内容的预告。
 * 下层是**静态假骨架**（灰条 + 一条假曲线），只是示意「这里有内容」——服务端根本没给真数据，
 * 模糊的不是真内容；上层居中一个登录按钮与一句说明。
 * summary：可选的几句预告文字；stats：可选的 [{ label, value, unit? }]，服务端给的预告数字。
 */
export default function LockedTeaser({ summary, stats, onLogin }) {
  const { t } = useI18n();
  return (
    <div className="card locked-wrap">
      <div className="locked-blur" aria-hidden="true">
        {BARS.map((w, i) => <div key={i} className="locked-bar" style={{ width: `${w}%` }} />)}
        <svg viewBox="0 0 600 120" preserveAspectRatio="none" className="locked-curve">
          <polyline fill="none" stroke="currentColor" strokeWidth="3"
            points="0,90 60,82 120,88 180,64 240,70 300,52 360,58 420,40 480,46 540,28 600,34" />
        </svg>
        {BARS.slice(0, 3).map((w, i) => <div key={`b${i}`} className="locked-bar" style={{ width: `${w - 10}%` }} />)}
      </div>
      <div className="locked-cta">
        {summary?.length > 0 && summary.map((s, i) => <p key={i} className="locked-line">{s}</p>)}
        {stats?.length > 0 && (
          <div className="locked-stats">
            {stats.map((s) => <StatTile key={s.label} label={s.label} value={s.value} unit={s.unit} />)}
          </div>
        )}
        <button className="btn primary" onClick={onLogin}>{t('lock.cta')}</button>
        <p className="note">{t('lock.note')}</p>
      </div>
    </div>
  );
}
