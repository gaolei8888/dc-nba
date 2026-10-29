import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, maskPhone, isMainland, countriesFor, COUNTRIES } from '../server/phone.mjs';

test('normalizePhone：各种写法归一', () => {
  for (const s of ['13800138000', '138 0013 8000', '138-0013-8000', '+86 138 0013 8000', '0086 13800138000', '8613800138000', '(138)00138000']) {
    assert.deepEqual(normalizePhone('86', s), { ok: true, e164: '+8613800138000' }, s);
  }
  assert.deepEqual(normalizePhone('1', '(202) 555-0147'), { ok: true, e164: '+12025550147' });
  assert.deepEqual(normalizePhone('44', '07700 900123'), { ok: true, e164: '+447700900123' }); // 去掉国内长途前缀 0
});

test('normalizePhone：非法号码', () => {
  for (const [cc, s] of [['86', '12800138000'], ['86', '1380013800'], ['86', '138001380001'], ['86', 'abc'], ['86', ''],
    ['1', '1025550147'], ['86', '+1 2025550147'], ['999', '12345678'], ['44', '1234567890123456']]) {
    assert.deepEqual(normalizePhone(cc, s), { ok: false, code: 'auth.phoneInvalid' }, `${cc} ${s}`);
  }
});

test('maskPhone：大陆号 138****8000，其他号保留区号与末四位', () => {
  assert.equal(maskPhone('+8613800138000'), '138****8000');
  assert.equal(maskPhone('+12025550147'), '+1 ****0147');
  assert.equal(maskPhone('+447700900123'), '+44 ****0123');
});

test('isMainland 与 countriesFor', () => {
  assert.equal(isMainland('+8613800138000'), true);
  assert.equal(isMainland('+85291234567'), false);
  assert.deepEqual(countriesFor(false), [{ cc: '86', iso: 'CN' }]);
  assert.equal(countriesFor(true).length, COUNTRIES.length);
});

test('normalizePhone：非 86/1 国家的无前缀、00 前缀与区号不符', () => {
  const sg = { ok: true, e164: '+6565123456' };
  assert.deepEqual(normalizePhone('65', '65123456'), sg); // 本地号恰以区号数字开头
  assert.deepEqual(normalizePhone('65', '+65 6512 3456'), sg);
  assert.deepEqual(normalizePhone('65', '6565123456'), sg);
  assert.deepEqual(normalizePhone('44', '447700900123'), { ok: true, e164: '+447700900123' });
  assert.deepEqual(normalizePhone('44', '0044 7700 900123'), { ok: true, e164: '+447700900123' });
  assert.deepEqual(normalizePhone('852', '9123 4567'), { ok: true, e164: '+85291234567' });
  assert.deepEqual(normalizePhone('44', '+1 2025550147'), { ok: false, code: 'auth.phoneInvalid' });
  assert.deepEqual(normalizePhone('65', '0065 6512 3456'), sg);
  assert.deepEqual(normalizePhone('65', '0044 7700900123'), { ok: false, code: 'auth.phoneInvalid' });
});

test('countriesFor 返回值不会污染 COUNTRIES', () => {
  assert.throws(() => { 'use strict'; COUNTRIES.push({ cc: '9', iso: 'XX' }); });
  const l = countriesFor(true); l.pop();
  assert.equal(countriesFor(true).length, COUNTRIES.length);
});
