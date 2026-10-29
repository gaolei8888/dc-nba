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
