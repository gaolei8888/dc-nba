import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ACCOUNT_SCHEMA } from '../server/db.mjs';
import {
  newCode, bjDayStart, requestCode, verifyCode, checkSendAllowed, smsStats, limitsFromEnv,
  DEFAULT_LIMITS, CODE_TTL_MS, MAX_ATTEMPTS, RESEND_MS, PHONE_DAILY,
} from '../server/loginCodes.mjs';

const T0 = Date.parse('2026-10-29T02:00:00Z'); // 北京 10:00
const P = '+8613800138000';
const IP = '1.2.3.4';
const BIG = { ipHourly: 1000, ipDaily: 1000, siteDaily: 1000 };

function fresh() {
  const h = new DatabaseSync(':memory:');
  h.exec(ACCOUNT_SCHEMA);
  return h;
}
// 假发送器：记下每次 send 的参数
function fake({ fail = false, delayMs = 0, ownsCode = false, checkOk = false } = {}) {
  const s = {
    id: 'fake', ownsCode, calls: [], checks: [],
    async send(e164, code) {
      s.calls.push({ e164, code });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return fail ? { ok: false, error: 'boom' } : { ok: true, providerId: 'id' + s.calls.length };
    },
  };
  if (ownsCode) s.check = async (e164, code) => { s.checks.push({ e164, code }); return { ok: checkOk }; };
  return s;
}
const req = (h, o) => requestCode(h, { e164: P, ip: IP, now: T0, limits: DEFAULT_LIMITS, ...o });

test('常量', () => {
  assert.equal(CODE_TTL_MS, 300_000); assert.equal(MAX_ATTEMPTS, 5);
  assert.equal(RESEND_MS, 60_000); assert.equal(PHONE_DAILY, 10);
  assert.deepEqual(DEFAULT_LIMITS, { ipHourly: 5, ipDaily: 20, siteDaily: 500 });
});

test('limitsFromEnv：非正整数回退默认', () => {
  assert.deepEqual(limitsFromEnv({}), DEFAULT_LIMITS);
  assert.deepEqual(limitsFromEnv({ SMS_IP_HOURLY: '8', SMS_IP_DAILY: '30', SMS_DAILY_CAP: '100' }),
    { ipHourly: 8, ipDaily: 30, siteDaily: 100 });
  assert.deepEqual(limitsFromEnv({ SMS_IP_HOURLY: '0', SMS_IP_DAILY: '-1', SMS_DAILY_CAP: 'abc' }), DEFAULT_LIMITS);
  assert.deepEqual(limitsFromEnv({ SMS_IP_HOURLY: '1.5', SMS_DAILY_CAP: '' }), DEFAULT_LIMITS);
});

test('newCode：6 位数字字符串，保留前导 0，0–9 都会出现', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) { const c = newCode(); assert.match(c, /^\d{6}$/); for (const ch of c) seen.add(ch); }
  assert.equal(seen.size, 10);
});

test('bjDayStart：按北京自然日', () => {
  assert.equal(bjDayStart(Date.parse('2026-10-29T15:59:00Z')), '2026-10-28T16:00:00.000Z');
  assert.equal(bjDayStart(Date.parse('2026-10-29T16:00:00Z')), '2026-10-29T16:00:00.000Z');
});

test('发送成功：库里只有哈希，5 分钟有效，60 秒内同号再发被拒', async () => {
  const s = fake(); const h = fresh();
  assert.deepEqual(await req(h, { sender: s }), { ok: true, resendAfterSec: 60, ttlSec: 300 });
  const row = h.prepare('SELECT * FROM login_codes WHERE e164 = ?').get(P);
  assert.match(s.calls[0].code, /^\d{6}$/);
  assert.notEqual(row.code_hash, s.calls[0].code);
  assert.equal(JSON.stringify(row).includes(s.calls[0].code), false);
  assert.equal(Date.parse(row.expires_at) - T0, 300_000);
  const again = await req(h, { now: T0 + 59_000, sender: s });
  assert.deepEqual(again, { ok: false, status: 429, code: 'auth.cooldown', params: { sec: 1 } });
  assert.equal(s.calls.length, 1);
});

test('同一号码每天最多 10 次；北京次日清零', async () => {
  const s = fake(); const h = fresh();
  for (let i = 0; i < 10; i++) {
    const r = await req(h, { now: T0 + i * 61_000, limits: BIG, sender: s });
    assert.equal(r.ok, true, `第 ${i + 1} 次`);
  }
  const r11 = await req(h, { now: T0 + 10 * 61_000, limits: BIG, sender: s });
  assert.deepEqual(r11, { ok: false, status: 429, code: 'auth.phoneDailyLimit' });
  const nextDay = Date.parse('2026-10-29T16:00:01Z'); // 北京 10-30 00:00:01
  assert.equal((await req(h, { now: nextDay, limits: BIG, sender: s })).ok, true);
});

test('同一 IP 每小时 5 次、每天 20 次（不同号码）', async () => {
  const s = fake(); const h = fresh();
  const phone = (i) => `+86138001${String(i).padStart(5, '0')}`;
  for (let i = 0; i < 5; i++) assert.equal((await req(h, { e164: phone(i), sender: s })).ok, true);
  assert.deepEqual(await req(h, { e164: phone(5), sender: s }),
    { ok: false, status: 429, code: 'auth.ipLimit' });
  // 每小时 5 次，分 4 个小时发满 20 次
  const h2 = fresh();
  let n = 0;
  for (let hr = 0; hr < 4; hr++) {
    for (let i = 0; i < 5; i++, n++) {
      const r = await req(h2, { e164: phone(n), now: T0 + hr * 3_600_000 + 1000, sender: s });
      assert.equal(r.ok, true, `第 ${n + 1} 次`);
    }
  }
  const r21 = await req(h2, { e164: phone(20), now: T0 + 4 * 3_600_000, sender: s });
  assert.deepEqual(r21, { ok: false, status: 429, code: 'auth.ipLimit' });
});

test('全站每日上限：达到 siteDaily 后停发、返回 503 auth.smsDailyCap，smsStats.capReached = true', async () => {
  const s = fake(); const h = fresh();
  const limits = { ...BIG, siteDaily: 3 };
  const phone = (i) => `+86138001${String(i).padStart(5, '0')}`;
  for (let i = 0; i < 3; i++) assert.equal((await req(h, { e164: phone(i), limits, sender: s })).ok, true);
  assert.deepEqual(smsStats(h, { now: T0, limits }),
    { sentToday: 3, failedToday: 0, cap: 3, capReached: true, lastFailureAt: null });
  assert.deepEqual(await req(h, { e164: phone(9), limits, sender: s }),
    { ok: false, status: 503, code: 'auth.smsDailyCap' });
  assert.equal(s.calls.length, 3);
});

test('发送失败不存码，如实返回失败，并记入 sms_sends', async () => {
  const h = fresh();
  const r = await req(h, { sender: fake({ fail: true }) });
  assert.deepEqual(r, { ok: false, status: 502, code: 'auth.smsFailed' });
  assert.equal(h.prepare('SELECT COUNT(*) n FROM login_codes').get().n, 0);
  assert.deepEqual({ ...h.prepare('SELECT ok, error FROM sms_sends').get() }, { ok: 0, error: 'boom' });
  const st = smsStats(h, { now: T0, limits: DEFAULT_LIMITS });
  assert.equal(st.failedToday, 1);
  assert.equal(st.lastFailureAt, new Date(T0).toISOString());
});

test('发送失败也计入限额（防对失败路径狂刷）', async () => {
  const h = fresh(); const s = fake({ fail: true });
  await req(h, { sender: s });
  const r = await req(h, { now: T0 + 1000, sender: s });
  assert.equal(r.code, 'auth.cooldown');
});

test('同一号码并发请求只发一条', async () => {
  const s = fake({ delayMs: 30 }); const h = fresh();
  const [a, b] = await Promise.all([1, 2].map(() => req(h, { sender: s })));
  assert.equal(s.calls.length, 1);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  const bad = a.ok ? b : a;
  assert.equal(bad.code, 'auth.cooldown');
  assert.deepEqual(bad.params, { sec: 60 });
});

test('验证：正确即作废；错 5 次作废；过期', async () => {
  const h = fresh(); const s = fake();
  await req(h, { sender: s });
  const code = s.calls[0].code;
  const wrong = code === '000000' ? '111111' : '000000';
  assert.deepEqual(await verifyCode(h, { e164: P, code, now: T0 + 1000, sender: s }), { ok: true });
  assert.deepEqual(await verifyCode(h, { e164: P, code, now: T0 + 2000, sender: s }), { ok: false, code: 'auth.codeExpired' });

  // 错 5 次
  const h2 = fresh(); const s2 = fake();
  await req(h2, { sender: s2 });
  const c2 = s2.calls[0].code; const w2 = c2 === '000000' ? '111111' : '000000';
  for (let left = 4; left >= 1; left--) {
    assert.deepEqual(await verifyCode(h2, { e164: P, code: w2, now: T0 + 1000, sender: s2 }),
      { ok: false, code: 'auth.codeInvalid', params: { left } });
  }
  assert.deepEqual(await verifyCode(h2, { e164: P, code: w2, now: T0 + 1000, sender: s2 }), { ok: false, code: 'auth.codeLocked' });
  assert.deepEqual(await verifyCode(h2, { e164: P, code: c2, now: T0 + 1000, sender: s2 }), { ok: false, code: 'auth.codeExpired' });

  // 过期
  const h3 = fresh(); const s3 = fake();
  await req(h3, { sender: s3 });
  assert.deepEqual(await verifyCode(h3, { e164: P, code: s3.calls[0].code, now: T0 + 300_001, sender: s3 }),
    { ok: false, code: 'auth.codeExpired' });
  // 没发过码
  assert.deepEqual(await verifyCode(fresh(), { e164: P, code: '123456', now: T0, sender: s }), { ok: false, code: 'auth.codeExpired' });
  void wrong;
});

test('新发的码顶替旧码并清零错误次数', async () => {
  const h = fresh(); const s = fake();
  await req(h, { sender: s });
  const old = s.calls[0].code;
  const bad = old === '000000' ? '111111' : '000000';
  for (let i = 0; i < 3; i++) await verifyCode(h, { e164: P, code: bad, now: T0 + 1000, sender: s });
  assert.equal((await req(h, { now: T0 + 61_000, sender: s })).ok, true);
  const fresher = s.calls[1].code;
  assert.equal(h.prepare('SELECT attempts FROM login_codes').get().attempts, 0);
  if (fresher !== old) {
    assert.equal((await verifyCode(h, { e164: P, code: old, now: T0 + 62_000, sender: s })).ok, false);
  }
  assert.deepEqual(await verifyCode(h, { e164: P, code: fresher, now: T0 + 63_000, sender: s }), { ok: true });
});

test('sms_sends 只追加：不能删、不能改', () => {
  const h = fresh();
  h.prepare("INSERT INTO sms_sends (e164, ip, at, provider, ok) VALUES ('+8613800138000', '1.2.3.4', '2026-10-29T00:00:00.000Z', 'fake', 1)").run();
  assert.throws(() => h.exec('DELETE FROM sms_sends'), /只追加/);
  assert.throws(() => h.exec('UPDATE sms_sends SET ok = 0'), /只追加/);
});

test('ownsCode 的发送器（Twilio Verify）：不生成码，校验交给 sender.check，本地仍管 5 分钟与 5 次', async () => {
  const h = fresh(); const s = fake({ ownsCode: true, checkOk: false }); s.id = 'twilio';
  assert.equal((await req(h, { sender: s })).ok, true);
  assert.equal(s.calls[0].code, null);
  const row = h.prepare('SELECT * FROM login_codes').get();
  assert.equal(row.code_hash, null); assert.equal(row.provider, 'twilio');
  for (let left = 4; left >= 1; left--) {
    assert.deepEqual(await verifyCode(h, { e164: P, code: '123456', now: T0 + 1000, sender: s }),
      { ok: false, code: 'auth.codeInvalid', params: { left } });
  }
  assert.deepEqual(await verifyCode(h, { e164: P, code: '123456', now: T0 + 1000, sender: s }), { ok: false, code: 'auth.codeLocked' });
  assert.equal(s.checks.length, 5);

  // 校验通过
  const h2 = fresh(); const s2 = fake({ ownsCode: true, checkOk: true }); s2.id = 'twilio';
  await req(h2, { sender: s2 });
  assert.deepEqual(await verifyCode(h2, { e164: P, code: '123456', now: T0 + 1000, sender: s2 }), { ok: true });
  assert.equal(h2.prepare('SELECT COUNT(*) n FROM login_codes').get().n, 0);
  // 过期不调 check
  const h3 = fresh(); const s3 = fake({ ownsCode: true, checkOk: true });
  await req(h3, { sender: s3 });
  assert.equal((await verifyCode(h3, { e164: P, code: '123456', now: T0 + 300_001, sender: s3 })).code, 'auth.codeExpired');
  assert.equal(s3.checks.length, 0);
});

test('checkSendAllowed：通过时带回计数', async () => {
  const h = fresh();
  const r = checkSendAllowed(h, { e164: P, ip: IP, now: T0, limits: DEFAULT_LIMITS });
  assert.deepEqual(r, { ok: true, ipSendsLastHour: 0, siteToday: 0 });
});

test('发送器抛异常：按失败处理，不存码', async () => {
  const h = fresh();
  const s = { id: 'x', async send() { throw new Error('net down'); } };
  assert.deepEqual(await req(h, { sender: s }), { ok: false, status: 502, code: 'auth.smsFailed' });
  assert.equal(h.prepare('SELECT COUNT(*) n FROM login_codes').get().n, 0);
  assert.equal(h.prepare('SELECT error FROM sms_sends').get().error, 'net down');
});
