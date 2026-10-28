import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createT } from '../web/src/i18n/core.js';
import { ApiError, toApiError, errorText } from '../web/src/lib/apiError.js';

const dir = path.resolve('web/src/i18n/locales');
const locales = {};
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
  locales[f.replace(/\.js$/, '')] = (await import(pathToFileURL(path.join(dir, f)).href)).default;
}
const t = createT({ dict: locales.en, fallback: locales.zh, lang: 'en' });
const CJK = /[一-鿿]/;

test('errorText：无 code 退回状态码文案，不回显服务端中文', () => {
  const e = new ApiError({ status: 503, code: null, message: '服务端存储不可用' });
  const s = errorText(e, t);
  assert.equal(s, t('err.http', { status: 503 }));
  assert.match(s, /503/);
  assert.doesNotMatch(s, CJK);
});

test('errorText：有 code 且能找到译文时用译文，参数插值', () => {
  const tt = (k, p) => (k === 'err.demo' ? `demo ${p?.n}` : `?${k}`);
  const e = new ApiError({ status: 400, code: 'err.demo', params: { n: 7 }, message: '中文原文' });
  assert.equal(errorText(e, tt), 'demo 7');
});

test('errorText：未知 code 也不回显中文', () => {
  const e = new ApiError({ status: 400, code: 'err.nope', params: {}, message: '两队不能相同' });
  assert.equal(errorText(e, t), t('err.http', { status: 400 }));
  assert.doesNotMatch(errorText(e, t), CJK);
});

test('errorText：未知异常不回显原文', () => {
  const orig = console.error; console.error = () => {};
  try {
    assert.equal(errorText(new Error('随便'), t), t('err.unknown'));
    assert.doesNotMatch(errorText(new Error('随便'), t), CJK);
  } finally { console.error = orig; }
});

test('toApiError：读取 body 的 code / params / error', async () => {
  const res = { status: 422, json: async () => ({ code: 'err.x', params: { a: 1 }, error: '坏了' }) };
  const e = await toApiError(res);
  assert.ok(e instanceof ApiError);
  assert.equal(e.status, 422);
  assert.equal(e.code, 'err.x');
  assert.deepEqual(e.params, { a: 1 });
  assert.equal(e.message, '坏了');
});

test('toApiError：body 不是 JSON 时 code 为 null', async () => {
  const e = await toApiError({ status: 502, json: async () => { throw new Error('bad'); } });
  assert.equal(e.status, 502);
  assert.equal(e.code, null);
  assert.deepEqual(e.params, {});
});

test('errorText：普通 TypeError 是 err.unknown，不当成网络错误', () => {
  const orig = console.error; console.error = () => {};
  try {
    assert.equal(errorText(new TypeError('x is undefined'), t), t('err.unknown'));
  } finally { console.error = orig; }
});

test('errorText：ApiError status 0 + err.network 显示网络文案', () => {
  const e = new ApiError({ status: 0, code: 'err.network' });
  assert.equal(errorText(e, t), t('err.network'));
  assert.notEqual(t('err.network'), t('err.unknown'));
});
