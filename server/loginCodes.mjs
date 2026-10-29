/**
 * 短信验证码与三层限频。纯逻辑 + 传入的 SQLite 句柄 h，便于用内存库测试。
 *
 *  - 验证码 6 位（crypto.randomInt），5 分钟有效，只存哈希，验证成功或错 5 次即作废。
 *  - 限频全部按 sms_sends 计数（重启不丢）：每次调用发送器都记一行、都计入限额（成功失败都算）。
 *      号码：60 秒一次、每天 10 次；IP：每小时 / 每天（可配）；全站：每天（可配）。
 *    「每天」一律按北京时间自然日。
 *  - 发送失败如实返回失败，不存验证码。
 *  - 日志里手机号一律脱敏，绝不打印验证码。
 */
import crypto from 'node:crypto';
import { maskPhone } from './phone.mjs';

export const CODE_TTL_MS = 300_000;
export const MAX_ATTEMPTS = 5;
export const RESEND_MS = 60_000;
export const PHONE_DAILY = 10;
export const DEFAULT_LIMITS = Object.freeze({ ipHourly: 5, ipDaily: 20, siteDaily: 500 });

const HOUR_MS = 3_600_000;
const BJ_OFFSET_MS = 8 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;

const posInt = (v, dflt) => (/^[1-9]\d*$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : dflt);

export function limitsFromEnv(env = process.env) {
  return {
    ipHourly: posInt(env.SMS_IP_HOURLY, DEFAULT_LIMITS.ipHourly),
    ipDaily: posInt(env.SMS_IP_DAILY, DEFAULT_LIMITS.ipDaily),
    siteDaily: posInt(env.SMS_DAILY_CAP, DEFAULT_LIMITS.siteDaily),
  };
}

export const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

/** 北京自然日 00:00 对应的 UTC ISO 串 */
export function bjDayStart(now) {
  const bjMs = now + BJ_OFFSET_MS;
  return new Date(bjMs - (((bjMs % DAY_MS) + DAY_MS) % DAY_MS) - BJ_OFFSET_MS).toISOString();
}

const iso = (ms) => new Date(ms).toISOString();
const hashCode = (salt, e164, code) =>
  crypto.createHash('sha256').update(`${salt}:${e164}:${code}`).digest('hex');
const count = (h, sql, ...args) => h.prepare(sql).get(...args).n;

/** 同一号码同时只允许一个在途请求（检查 + 发送期间占位） */
const inflight = new Set();
/** 全站触顶的服务器日志每个北京日只打一次 */
let capWarnedDay = null;

/** 只读检查：能不能给这个号码 / IP 再发一条 */
export function checkSendAllowed(h, { e164, ip, now, limits = DEFAULT_LIMITS }) {
  const day = bjDayStart(now);

  const last = h.prepare('SELECT at FROM sms_sends WHERE e164 = ? ORDER BY id DESC LIMIT 1').get(e164);
  if (last) {
    const wait = Date.parse(last.at) + RESEND_MS - now;
    if (wait > 0) return { ok: false, status: 429, code: 'auth.cooldown', params: { sec: Math.ceil(wait / 1000) } };
  }
  if (count(h, 'SELECT COUNT(*) n FROM sms_sends WHERE e164 = ? AND at >= ?', e164, day) >= PHONE_DAILY) {
    return { ok: false, status: 429, code: 'auth.phoneDailyLimit' };
  }
  let ipSendsLastHour = 0;
  if (ip) {
    ipSendsLastHour = count(h, 'SELECT COUNT(*) n FROM sms_sends WHERE ip = ? AND at > ?', ip, iso(now - HOUR_MS));
    const ipToday = count(h, 'SELECT COUNT(*) n FROM sms_sends WHERE ip = ? AND at >= ?', ip, day);
    if (ipSendsLastHour >= limits.ipHourly || ipToday >= limits.ipDaily) {
      return { ok: false, status: 429, code: 'auth.ipLimit' };
    }
  }
  const siteToday = count(h, 'SELECT COUNT(*) n FROM sms_sends WHERE at >= ?', day);
  if (siteToday >= limits.siteDaily) {
    if (capWarnedDay !== day) {
      capWarnedDay = day;
      console.warn(`!! [sms] 全站今日短信已达上限 ${limits.siteDaily}，停发至北京次日`);
    }
    return { ok: false, status: 503, code: 'auth.smsDailyCap' };
  }
  return { ok: true, ipSendsLastHour, siteToday };
}

/** 申请验证码：限频 → 调发送器 → 记流水 → 成功才存码 */
export async function requestCode(h, { e164, ip, now, limits = DEFAULT_LIMITS, sender }) {
  if (inflight.has(e164)) {
    return { ok: false, status: 429, code: 'auth.cooldown', params: { sec: RESEND_MS / 1000 } };
  }
  inflight.add(e164); // 同步占位，之后才有 await
  try {
    const gate = checkSendAllowed(h, { e164, ip, now, limits });
    if (!gate.ok) return gate;

    const code = sender.ownsCode ? null : newCode();
    let res;
    try {
      res = await sender.send(e164, code);
    } catch (e) {
      res = { ok: false, error: String(e?.message ?? e) };
    }
    const ok = res?.ok === true;
    h.prepare('INSERT INTO sms_sends (e164, ip, at, provider, ok, provider_id, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(e164, ip ?? null, iso(now), sender.id, ok ? 1 : 0, ok ? (res.providerId ?? null) : null,
        ok ? null : String(res?.error ?? 'unknown').slice(0, 300));
    if (!ok) {
      console.warn(`!! [sms] 发送失败 ${maskPhone(e164)} via ${sender.id}: ${String(res?.error ?? 'unknown').slice(0, 120)}`);
      return { ok: false, status: 502, code: 'auth.smsFailed' };
    }
    const salt = code === null ? null : crypto.randomBytes(16).toString('hex');
    h.prepare(`INSERT INTO login_codes (e164, provider, code_hash, salt, created_at, expires_at, attempts)
               VALUES (?, ?, ?, ?, ?, ?, 0)
               ON CONFLICT(e164) DO UPDATE SET provider = excluded.provider, code_hash = excluded.code_hash,
                 salt = excluded.salt, created_at = excluded.created_at, expires_at = excluded.expires_at, attempts = 0`)
      .run(e164, sender.id, code === null ? null : hashCode(salt, e164, code), salt, iso(now), iso(now + CODE_TTL_MS));
    return { ok: true, resendAfterSec: RESEND_MS / 1000, ttlSec: CODE_TTL_MS / 1000 };
  } finally {
    inflight.delete(e164);
  }
}

/** 校验验证码：正确或错满 5 次即删除；过期 / 不存在统一说「已失效」 */
export async function verifyCode(h, { e164, code, now, sender }) {
  const row = h.prepare('SELECT * FROM login_codes WHERE e164 = ?').get(e164);
  const drop = () => h.prepare('DELETE FROM login_codes WHERE e164 = ?').run(e164);
  if (!row) return { ok: false, code: 'auth.codeExpired' };
  if (now > Date.parse(row.expires_at) || row.attempts >= MAX_ATTEMPTS) {
    drop();
    return { ok: false, code: 'auth.codeExpired' };
  }
  // 先记一次尝试再校验：校验中途（异步）进来的并发请求也占名额，不能借此绕过 5 次
  const attempts = row.attempts + 1;
  h.prepare('UPDATE login_codes SET attempts = ? WHERE e164 = ?').run(attempts, e164);

  let good;
  if (row.code_hash === null) {
    try {
      good = (await sender.check(e164, String(code ?? '')))?.ok === true;
    } catch (e) {
      console.warn(`!! [sms] 校验调用失败 ${maskPhone(e164)}: ${String(e?.message ?? e).slice(0, 120)}`);
      good = false;
    }
  } else {
    const want = Buffer.from(row.code_hash, 'hex');
    const got = Buffer.from(hashCode(row.salt, e164, String(code ?? '')), 'hex');
    good = want.length === got.length && crypto.timingSafeEqual(want, got);
  }
  if (good) { drop(); return { ok: true }; }
  if (attempts >= MAX_ATTEMPTS) { drop(); return { ok: false, code: 'auth.codeLocked' }; }
  return { ok: false, code: 'auth.codeInvalid', params: { left: MAX_ATTEMPTS - attempts } };
}

/** 今日（北京）发送概况，给 /api/health 报警用。sentToday 含失败的调用（都计入限额） */
export function smsStats(h, { now, limits = DEFAULT_LIMITS }) {
  const day = bjDayStart(now);
  const sentToday = count(h, 'SELECT COUNT(*) n FROM sms_sends WHERE at >= ?', day);
  const failedToday = count(h, 'SELECT COUNT(*) n FROM sms_sends WHERE at >= ? AND ok = 0', day);
  const lastFailureAt = h.prepare('SELECT MAX(at) a FROM sms_sends WHERE ok = 0').get().a ?? null;
  return { sentToday, failedToday, cap: limits.siteDaily, capReached: sentToday >= limits.siteDaily, lastFailureAt };
}
