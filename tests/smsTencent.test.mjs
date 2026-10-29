import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { tc3Sign, createTencentSender } from '../server/smsTencent.mjs';

const okResp = (obj) => ({ ok: true, status: 200, json: async () => obj });
const OK_BODY = { Response: { SendStatusSet: [{ Code: 'Ok', SerialNo: 'sn1' }], RequestId: 'r1' } };
const sender = (resp, extra = {}) => createTencentSender({ secretId: 'id', secretKey: 'key', nowSec: () => 1761700000, fetchImpl: async () => resp, ...extra });

test('tc3Sign：与按官方步骤手算的期望值一致（时间戳跨 UTC 日界）', () => {
  // 固定向量：官方文档示例的密钥是打码的，无法逐字抄；这里按文档「签名方法 v3」的步骤，
  // 用字面量逐步手算（不复用实现里的任何函数）。2019-02-25T23:59:59Z，北京已是 26 日，验证用 UTC 日期。
  const input = {
    secretId: 'AKIDEXAMPLE', secretKey: 'SECRETKEYEXAMPLE', service: 'sms', host: 'sms.tencentcloudapi.com',
    action: 'SendSms', version: '2021-01-11', region: 'ap-guangzhou', timestamp: 1551139199,
    payload: '{"PhoneNumberSet":["+8613800138000"]}',
  };
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const canonical = 'POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:sms.tencentcloudapi.com\nx-tc-action:sendsms\n\n'
    + 'content-type;host;x-tc-action\n' + sha(input.payload);
  const sts = 'TC3-HMAC-SHA256\n1551139199\n2019-02-25/sms/tc3_request\n' + sha(canonical);
  const h = (k, m) => crypto.createHmac('sha256', k).update(m).digest();
  const sig = h(h(h(h('TC3SECRETKEYEXAMPLE', '2019-02-25'), 'sms'), 'tc3_request'), sts).toString('hex');
  const headers = tc3Sign(input);
  assert.equal(headers.Authorization,
    `TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2019-02-25/sms/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=${sig}`);
  assert.equal(headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(headers.Host, 'sms.tencentcloudapi.com');
  assert.equal(headers['X-TC-Timestamp'], '1551139199');
  // 防回归：签名值本身固定，实现被改动会立刻发现
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.notEqual(tc3Sign({ ...input, timestamp: 1551139200 }).Authorization, headers.Authorization);
});

test('发送：请求体与模板参数', async () => {
  const calls = [];
  const s = createTencentSender({ secretId: 'id', secretKey: 'key', nowSec: () => 1761700000,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return okResp(OK_BODY); } });
  assert.deepEqual(await s.send('+8613800138000', '012345'), { ok: true, providerId: 'sn1' });
  assert.equal(s.id, 'tencent');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { PhoneNumberSet: ['+8613800138000'], SmsSdkAppId: '1400683809', SignName: '上海磊宁科技有限公司', TemplateId: '1417875', TemplateParamSet: ['012345', '5'] });
  assert.equal(calls[0].url, 'https://sms.tencentcloudapi.com/');
  assert.equal(calls[0].init.headers['X-TC-Action'], 'SendSms');
  assert.equal(calls[0].init.headers['X-TC-Version'], '2021-01-11');
  assert.equal(calls[0].init.headers['X-TC-Region'], 'ap-guangzhou');
});

test('HTTP 200 但 Code 非 Ok 算失败', async () => {
  const s = sender(okResp({ Response: { SendStatusSet: [{ Code: 'LimitExceeded.PhoneNumberDailyLimit', Message: '…' }], RequestId: 'r' } }));
  const r = await s.send('+8613800138000', '123456');
  assert.equal(r.ok, false);
  assert.match(r.error, /LimitExceeded\.PhoneNumberDailyLimit/);
});

test('Response.Error（如签名错误）算失败', async () => {
  const r = await sender(okResp({ Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: 'bad' }, RequestId: 'r' } })).send('+8613800138000', '123456');
  assert.equal(r.ok, false);
  assert.match(r.error, /AuthFailure\.SignatureFailure/);
});

test('网络错误 / 超时算失败，不抛', async () => {
  const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const r = await createTencentSender({ secretId: 'id', secretKey: 'key', fetchImpl: async () => { throw abort; } }).send('+8613800138000', '123456');
  assert.equal(r.ok, false);
  assert.match(r.error, /timeout|abort/i);
  const r2 = await createTencentSender({ secretId: 'id', secretKey: 'key', fetchImpl: async () => { throw new Error('ECONNRESET'); } }).send('+8613800138000', '123456');
  assert.equal(r2.ok, false);
});

test('响应不是 JSON / 缺 SendStatusSet 也算失败，不抛', async () => {
  const bad = { ok: true, status: 502, json: async () => { throw new SyntaxError('x'); } };
  assert.equal((await sender(bad).send('+8613800138000', '1')).ok, false);
  assert.equal((await sender(okResp({ Response: { RequestId: 'r' } })).send('+8613800138000', '1')).ok, false);
});

test('param2 为空字符串时只传验证码', async () => {
  let body;
  const s = createTencentSender({ secretId: 'id', secretKey: 'key', param2: '',
    fetchImpl: async (u, init) => { body = JSON.parse(init.body); return okResp(OK_BODY); } });
  await s.send('+8613800138000', '123456');
  assert.deepEqual(body.TemplateParamSet, ['123456']);
});

test('错误信息里不带密钥', async () => {
  const SECRET = 'SuperSecretKey123';
  const leaky = createTencentSender({ secretId: 'AKIDabc', secretKey: SECRET, fetchImpl: async () => { throw new Error(`boom ${SECRET} AKIDabc`); } });
  const r1 = await leaky.send('+8613800138000', '1');
  const r2 = await createTencentSender({ secretId: 'AKIDabc', secretKey: SECRET,
    fetchImpl: async () => okResp({ Response: { Error: { Code: 'X', Message: `echo ${SECRET}` } } }) }).send('+8613800138000', '1');
  for (const r of [r1, r2]) { assert.equal(r.ok, false); assert.ok(!r.error.includes(SECRET)); assert.ok(!r.error.includes('AKIDabc')); }
});
