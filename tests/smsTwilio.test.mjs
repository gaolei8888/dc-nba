import test from 'node:test';
import assert from 'node:assert/strict';
import { createTwilioVerifySender } from '../server/smsTwilio.mjs';
import { createSenders, pickSender, consoleSender, disabledSender } from '../server/sms.mjs';

const resp = (status, obj) => ({ status, ok: status < 300, json: async () => obj });
const E = '+12025550147';

test('Twilio Verify：send 不带我们的码，status=pending 算成功', async () => {
  const calls = [];
  const s = createTwilioVerifySender({ accountSid: 'ACxx', authToken: 'tok', serviceSid: 'VAxxx',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return resp(201, { sid: 'VE1', status: 'pending' }); } });
  assert.equal(s.ownsCode, true);
  assert.equal(s.id, 'twilio');
  assert.deepEqual(await s.send(E, null), { ok: true, providerId: 'VE1' });
  assert.ok(calls[0].url.endsWith('/v2/Services/VAxxx/Verifications'));
  assert.equal(calls[0].init.body, 'To=%2B12025550147&Channel=sms');
  assert.equal(calls[0].init.headers.Authorization, 'Basic ' + Buffer.from('ACxx:tok').toString('base64'));
});

test('send 失败（HTTP 错误 / 网络错误）如实失败且不带凭据', async () => {
  const s = createTwilioVerifySender({ accountSid: 'ACxx', authToken: 'tok', serviceSid: 'VAxxx', fetchImpl: async () => resp(429, { code: 60203 }) });
  const r = await s.send(E, null);
  assert.equal(r.ok, false); assert.match(r.error, /429/); assert.ok(!r.error.includes('tok'));
  const s2 = createTwilioVerifySender({ accountSid: 'ACxx', authToken: 'tok', serviceSid: 'VAxxx', fetchImpl: async () => { throw Object.assign(new Error('tok'), { name: 'TimeoutError' }); } });
  const r2 = await s2.send(E, null);
  assert.equal(r2.ok, false); assert.match(r2.error, /timeout/); assert.ok(!r2.error.includes('tok'));
});

test('check：approved 才算通过', async () => {
  const calls = [];
  const mk = (status, body) => createTwilioVerifySender({ accountSid: 'ACxx', authToken: 'tok', serviceSid: 'VAxxx',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return resp(status, body); } });
  assert.equal((await mk(200, { status: 'approved' }).check(E, '123456')).ok, true);
  assert.ok(calls[0].url.endsWith('/VerificationCheck'));
  assert.equal(calls[0].init.body, 'To=%2B12025550147&Code=123456');
  assert.equal((await mk(200, { status: 'pending' }).check(E, '123456')).ok, false);
  assert.equal((await mk(404, { code: 20404 }).check(E, '123456')).ok, false);
  const boom = createTwilioVerifySender({ accountSid: 'a', authToken: 'b', serviceSid: 'c', fetchImpl: async () => { throw new Error('x'); } });
  assert.equal((await boom.check(E, '1')).ok, false);
});

test('createSenders：海外默认关闭，+86 以外 pickSender 返回 auth.overseasClosed', () => {
  const s = createSenders({ NODE_ENV: 'production' });
  assert.equal(s.overseasOn, false); assert.equal(s.overseas, null);
  assert.deepEqual(pickSender(s, '+12025550147'), { code: 'auth.overseasClosed' });
  assert.equal(pickSender(s, '+8613800138000').sender.id, 'disabled');
});

test('createSenders：console 发送器只在非 production', () => {
  assert.equal(createSenders({ SMS_PROVIDER: 'console', NODE_ENV: 'development' }).mainland.id, 'console');
  assert.equal(createSenders({ SMS_PROVIDER: 'console', NODE_ENV: 'production' }).mainland.id, 'disabled');
  assert.equal(createSenders({ TENCENT_SMS_SECRET_ID: 'a', TENCENT_SMS_SECRET_KEY: 'b' }).mainland.id, 'tencent');
  assert.equal(createSenders({ SMS_PROVIDER: 'disabled', TENCENT_SMS_SECRET_ID: 'a', TENCENT_SMS_SECRET_KEY: 'b' }).mainland.id, 'disabled');
});

test('createSenders：ENABLE_OVERSEAS_SMS=1 但缺 Twilio 变量时仍视为关闭；齐全时启用', () => {
  const s = createSenders({ ENABLE_OVERSEAS_SMS: '1' });
  assert.equal(s.overseasOn, false); assert.equal(s.overseas, null);
  assert.deepEqual(pickSender(s, E), { code: 'auth.overseasClosed' });
  const on = createSenders({ ENABLE_OVERSEAS_SMS: '1', TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_VERIFY_SERVICE_SID: 'VA' });
  assert.equal(on.overseasOn, true);
  assert.equal(pickSender(on, E).sender.id, 'twilio');
  assert.equal(createSenders({ TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_VERIFY_SERVICE_SID: 'VA' }).overseasOn, false);
});

test('createSenders：TENCENT 环境变量传入（含 PARAM2 空串），describe 不含密钥', async () => {
  let body;
  const s = createSenders({ TENCENT_SMS_SECRET_ID: 'IDSECRET', TENCENT_SMS_SECRET_KEY: 'KEYSECRET', TENCENT_SMS_PARAM2: '', TENCENT_SMS_TEMPLATE_ID: '99' },
    { fetchImpl: async (u, init) => { body = JSON.parse(init.body); return { json: async () => ({ Response: { SendStatusSet: [{ Code: 'Ok', SerialNo: 's' }] } }) }; } });
  assert.equal((await s.mainland.send('+8613800138000', '123456')).ok, true);
  assert.deepEqual(body.TemplateParamSet, ['123456']);
  assert.equal(body.TemplateId, '99');
  assert.ok(!JSON.stringify(s.describe).match(/SECRET/));
});

test('consoleSender 脱敏手机号并打印验证码；disabledSender 恒失败', async () => {
  const lines = [];
  const r = await consoleSender({ log: (l) => lines.push(l) }).send('+8613800138000', '123456');
  assert.equal(r.ok, true);
  assert.equal(lines[0], '[sms:console] 138****8000 验证码 123456');
  assert.deepEqual(await disabledSender('关').send('+8613800138000', '1'), { ok: false, error: '关' });
});

test('createSenders：生产环境失败即关闭，只有未设置或显式 tencent 才真发', () => {
  const keys = { TENCENT_SMS_SECRET_ID: 'a', TENCENT_SMS_SECRET_KEY: 'b' };
  const warns = [];
  const log = { log() {}, warn: (m) => warns.push(m) };
  const c = createSenders({ ...keys, SMS_PROVIDER: 'console', NODE_ENV: 'production' }, { log });
  assert.equal(c.mainland.id, 'disabled');
  assert.equal(c.describe.mainland, 'disabled（production 禁用 console）');
  assert.equal(warns.length, 1);
  const typo = createSenders({ ...keys, SMS_PROVIDER: 'tencnet', NODE_ENV: 'production' }, { log });
  assert.equal(typo.mainland.id, 'disabled');
  assert.equal(warns.length, 2);
  assert.equal(createSenders({ ...keys, NODE_ENV: 'production' }, { log }).mainland.id, 'tencent');
  assert.equal(createSenders({ ...keys, SMS_PROVIDER: 'tencent', NODE_ENV: 'production' }, { log }).mainland.id, 'tencent');
  assert.equal(createSenders({ SMS_PROVIDER: 'tencent', NODE_ENV: 'production' }, { log }).mainland.id, 'disabled');
});
