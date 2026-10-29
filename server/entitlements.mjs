/**
 * 统一权限入口：can(user, feature) + 三个被锁接口的预告裁剪。
 * 纯函数、无 IO。预告裁剪是安全边界——只能白名单式拷贝字段，绝不展开 full。
 */

/** 被锁功能：board.stats 管 /api/predictions/summary 与 /api/shadow；board.paper 管 /api/paper */
export const FEATURES = ['board.stats', 'board.paper'];

/** 各等级能用的功能。今天只有 free，且全开；以后加付费档只改这里 */
export const TIER_FEATURES = { free: ['board.stats', 'board.paper'] };

/** 有效等级：非 free 且已过期 → free；未知等级 → free */
export function effectiveTier(user, now = Date.now()) {
  const tier = user?.tier;
  if (!tier || tier === 'free' || !Object.hasOwn(TIER_FEATURES, tier)) return 'free';
  const exp = user.tier_expires_at;
  if (exp != null) {
    const t = typeof exp === 'number' ? exp : Date.parse(exp);
    // 到期时间无法解析也按过期处理（宁可回落 free，不放大权限）
    if (!Number.isFinite(t) || t <= now) return 'free';
  }
  return tier;
}

export function can(user, feature, now = Date.now()) {
  if (!user) return false;
  return TIER_FEATURES[effectiveTier(user, now)]?.includes(feature) === true;
}

/**
 * 路由层判定。accountsOn 为 false 时一律放行（现状不变）。
 * reason：anonymous 未带令牌；session 令牌失效；tier 已登录但等级不够。
 */
export function gate(feature, { accountsOn, user, state, now = Date.now() }) {
  if (!accountsOn) return { allowed: true, reason: null };
  if (can(user, feature, now)) return { allowed: true, reason: null };
  if (!user) return { allowed: false, reason: state === 'invalid' ? 'session' : 'anonymous' };
  return { allowed: false, reason: 'tier' };
}

/**
 * 预测总表预告。字段映射（均为现有负载里的真实字段）：
 *   completed = full.overall.n（已结束场数），remaining = full.upcomingDist.n（未开打场数）。
 * summary[0] 与 summaryMsg[0] 原样转发（可能是字符串或 { code, params }，不关心形状）。
 */
export function teaserBoard(full) {
  return {
    locked: true,
    seasonYear: full?.seasonYear ?? null,
    summary: full?.summary?.length ? [full.summary[0]] : [],
    // 与 summary 逐句对应的消息码，前端按语言渲染；同样只取第 0 条，缺失时为空数组
    summaryMsg: full?.summaryMsg?.length ? [full.summaryMsg[0]] : [],
    teaser: { completed: full?.overall?.n ?? null, remaining: full?.upcomingDist?.n ?? null },
  };
}

/**
 * 模拟投注预告。映射：backtestBets = backtest.headline.bets，seasons = backtest.headline.seasons，
 * ledgerCaptured = ledger.captured（账本不可用时为 null）。
 */
export function teaserPaper(full) {
  const h = full?.backtest?.headline;
  const l = full?.ledger;
  return {
    locked: true,
    teaser: {
      backtestBets: h?.bets ?? null,
      seasons: Array.isArray(h?.seasons) ? [...h.seasons] : [],
      ledgerCaptured: l?.available ? (l.captured ?? null) : null,
    },
  };
}

/** 影子运行预告：只说有没有 */
export function teaserShadow(full) {
  return { available: full?.available === true, locked: true };
}
