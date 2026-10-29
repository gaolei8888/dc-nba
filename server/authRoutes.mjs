/**
 * /api/auth 路由工厂与请求身份解析。
 *
 *  - 凭证一律 `Authorization: Bearer <会话令牌>`，不用 cookie。
 *  - 错误一律走 sendError：{ error: 中文（只给日志 / curl）, code, params } + 对应 HTTP 状态，前端按 code 翻译。
 *  - 发码顺序：同意 → 号码规范化 → 选发送器（disabled 直接 503，不调用、不记流水）
 *    → 限频检查（触发小时 / 每日上限时记进 captcha.noteLimited；60 秒重发冷却不算）→ 是否需要图形验证 → 发送。
 *  - 绑定玩家档案时，匿名档案 id 只能由服务端从匿名令牌解析（players.authenticate），绝不取自请求体。
 *  - 日志里手机号一律脱敏，绝不打印验证码与令牌。
 */
import express from 'express';
import { normalizePhone, maskPhone } from './phone.mjs';
import { checkSendAllowed, requestCode, verifyCode, pendingFor, DEFAULT_LIMITS } from './loginCodes.mjs';
import {
  CONSENT_VERSION, findOrCreateUser, createSession, sessionUser, revokeSession,
  bindPlayer, setPrefs, publicUser,
} from './accounts.mjs';
import { pickSender } from './sms.mjs';
import { needsCaptcha } from './captcha.mjs';
import { sendError } from './messages.mjs';

/** 中文兜底文案：只给日志 / curl 排查，前端一律按 code 翻译 */
const ZH = {
  'auth.unavailable': '账号服务暂不可用',
  'auth.phoneInvalid': '手机号格式不正确',
  'auth.consentRequired': '请先阅读并同意用户协议与隐私政策',
  'auth.overseasClosed': '海外号码暂未开放',
  'auth.smsUnavailable': '短信服务暂不可用',
  'auth.captchaRequired': '请先完成图形验证',
  'auth.captchaWrong': '图形验证码不正确',
  'auth.cooldown': '发送太频繁，请稍后再试',
  'auth.phoneDailyLimit': '该号码今日发送次数已达上限',
  'auth.ipLimit': '当前网络发送次数过多，请稍后再试',
  'auth.smsDailyCap': '今日短信额度已用完，请明天再试',
  'auth.smsFailed': '短信发送失败，请稍后重试',
  'auth.codeExpired': '验证码已失效，请重新获取',
  'auth.codeInvalid': '验证码不正确',
  'auth.codeLocked': '错误次数过多，请重新获取验证码',
  'auth.sessionInvalid': '登录已失效，请重新登录',
  'auth.prefsInvalid': '偏好设置不合法',
  'err.internal': '服务器内部错误',
};

/**
 * 这些拒绝属于「小时 / 每日上限」：之后一小时该 IP 要先过图形验证。
 * 60 秒重发冷却（auth.cooldown）故意不在内——正常用户多点一次不该被要求图形验证。
 */
const LIMIT_CODES = new Set(['auth.ipLimit', 'auth.phoneDailyLimit', 'auth.smsDailyCap']);

/** 验证失败的 HTTP 状态：错满次数按 429，其余 400 */
const VERIFY_STATUS = { 'auth.codeLocked': 429 };

const fail = (res, status, code, params = {}, extra = {}) =>
  sendError(res, status, code, ZH[code] ?? code, params, extra);

const bearer = (req) => {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.get?.('authorization') ?? req.headers?.authorization ?? '');
  return m ? m[1] : null;
};

/**
 * 解析请求身份。state：none 没带令牌（或库不可用）；valid 会话有效；invalid 带了但无效 / 过期 / 已退出。
 * 只有 valid 才返回 user——invalid 时 user 恒为 null，gate 不可能被一个失效会话骗过。
 */
export function userFromRequest(h, req, now) {
  if (!h) return { user: null, state: 'none' };
  const token = bearer(req);
  if (!token) return { user: null, state: 'none' };
  const user = sessionUser(h, token, now);
  return user ? { user, state: 'valid' } : { user: null, state: 'invalid' };
}

export function createAuthRouter({
  h, senders, captcha, limits = DEFAULT_LIMITS, clock = Date.now,
  rateLimit = (opts) => (req, res, next) => next(), players = null,
}) {
  const router = express.Router();

  // 库打不开：所有路由 503
  router.use((req, res, next) => (h ? next() : fail(res, 503, 'auth.unavailable')));

  /** Express 4 不接 async 异常：统一兜住，对外只给 err.internal */
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      console.warn(`!! [auth] ${req.method} ${req.path} 出错: ${String(e?.message ?? e).replace(/\+?\d{7,}/g, '***').slice(0, 200)}`);
      if (!res.headersSent) fail(res, 500, 'err.internal');
    }
  };

  const bodyOf = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
  const phoneOf = (b) => normalizePhone(String(b.cc ?? ''), b.phone);
  const newCaptcha = (now) => captcha.issue(now);

  /** 需要会话的路由：无效一律 401 */
  const requireSession = (req, res, next) => {
    const { user, state } = userFromRequest(h, req, clock());
    if (state !== 'valid') return fail(res, 401, 'auth.sessionInvalid');
    req.account = user;
    next();
  };

  const playerOf = (playerId) => (playerId && players ? players.byId(playerId) ?? null : null);

  router.post('/captcha', rateLimit({ key: 'auth-captcha', max: 30, windowMs: 600_000 }), wrap(async (req, res) => {
    res.json(newCaptcha(clock()));
  }));

  router.post('/code', rateLimit({ key: 'auth-code', max: 20, windowMs: 600_000 }), wrap(async (req, res) => {
    const b = bodyOf(req);
    const now = clock();
    const ip = req.ip || null;
    if (b.consent !== true) return fail(res, 400, 'auth.consentRequired');
    const p = phoneOf(b);
    if (!p.ok) return fail(res, 400, p.code);
    const picked = pickSender(senders, p.e164);
    if (!picked.sender) return fail(res, 400, picked.code);
    const sender = picked.sender;
    // 没配密钥 / 被关闭：不调用、不记 sms_sends
    if (sender.id === 'disabled') return fail(res, 503, 'auth.smsUnavailable');

    const limited = (r) => {
      if (LIMIT_CODES.has(r.code)) captcha.noteLimited(ip, now);
      return fail(res, r.status ?? 429, r.code, r.params ?? {});
    };
    // 带上在途数：并发请求还没写进 sms_sends，不算进去的话同一 IP 并发的第 3 个也能跳过图形验证
    const inFlight = pendingFor(h, ip);
    const gate = checkSendAllowed(h, { e164: p.e164, ip, now, limits, pendingIp: inFlight.ip, pendingSite: inFlight.site });
    if (!gate.ok) return limited(gate);

    const need = needsCaptcha({
      ipSendsLastHour: gate.ipSendsLastHour, siteToday: gate.siteToday, cap: limits.siteDaily,
      now, store: captcha, ip,
    });
    if (need) {
      if (!b.captchaId || b.captchaAnswer === undefined) {
        return fail(res, 428, 'auth.captchaRequired', {}, { captcha: newCaptcha(now) });
      }
      // 一次性：无论对错都作废，答错附一张新图省一次往返
      if (!captcha.verify(String(b.captchaId), typeof b.captchaAnswer === 'string' ? b.captchaAnswer : null, now)) {
        return fail(res, 400, 'auth.captchaWrong', {}, { captcha: newCaptcha(now) });
      }
    }

    const r = await requestCode(h, { e164: p.e164, ip, now, limits, sender });
    if (!r.ok) return limited(r);
    res.json({ ok: true, resendAfterSec: r.resendAfterSec, ttlSec: r.ttlSec });
  }));

  router.post('/verify', rateLimit({ key: 'auth-verify', max: 30, windowMs: 600_000 }), wrap(async (req, res) => {
    const b = bodyOf(req);
    const now = clock();
    if (b.consent !== true || b.consentVersion !== CONSENT_VERSION) return fail(res, 400, 'auth.consentRequired');
    const p = phoneOf(b);
    if (!p.ok) return fail(res, 400, p.code);
    const picked = pickSender(senders, p.e164);
    if (!picked.sender) return fail(res, 400, picked.code);

    const v = await verifyCode(h, { e164: p.e164, code: b.code, now, sender: picked.sender });
    if (!v.ok) return fail(res, VERIFY_STATUS[v.code] ?? 400, v.code, v.params ?? {});

    const { user, created } = findOrCreateUser(h, { e164: p.e164, consentVersion: CONSENT_VERSION, now });
    if (created) console.log(`[auth] 新账号 ${maskPhone(p.e164)}`);
    // 匿名档案只认服务端从匿名令牌解析出的 id；请求体里的任何玩家 id 一律忽略
    const anon = players && typeof b.anonToken === 'string' && b.anonToken ? players.authenticate(b.anonToken) : null;
    const profileName = typeof b.profileName === 'string' ? b.profileName.trim().slice(0, 24) : '';
    const { playerId, outcome } = bindPlayer(h, {
      userId: user.id, anonPlayerId: anon?.id ?? null, profileName: profileName || undefined, players,
    });
    const { token, expiresAt } = createSession(h, user.id, now);
    res.json({ token, expiresAt, user: publicUser(user), player: playerOf(playerId), outcome });
  }));

  router.get('/me', requireSession, wrap(async (req, res) => {
    res.json({ user: publicUser(req.account), player: playerOf(req.account.player_id) });
  }));

  // 幂等：令牌无效 / 已退出 / 没带都回 ok
  router.post('/logout', wrap(async (req, res) => {
    const token = bearer(req);
    if (token) revokeSession(h, token, clock());
    res.json({ ok: true });
  }));

  router.post('/prefs', requireSession, wrap(async (req, res) => {
    const b = bodyOf(req);
    const prefs = {};
    if ('lang' in b) prefs.lang = b.lang;
    if ('tz' in b) prefs.tz = b.tz;
    if (!setPrefs(h, req.account.id, prefs)) return fail(res, 400, 'auth.prefsInvalid');
    res.json({ ok: true });
  }));

  return router;
}
