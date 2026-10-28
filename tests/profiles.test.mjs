import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createT } from '../web/src/i18n/core.js';
import { errorText } from '../web/src/lib/apiError.js';

// profiles.js 只用 localStorage（读写都有 try/catch），node 里给个内存版即可
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const { ensureProfile, createProfile, importProfile, exportProfile } = await import('../web/src/lib/profiles.js');

const dir = path.resolve('web/src/i18n/locales');
const locales = {};
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
  locales[f.replace(/\.js$/, '')] = (await import(pathToFileURL(path.join(dir, f)).href)).default;
}
const tFor = (lang) => createT({ dict: locales[lang], fallback: locales.zh, lang });

test('ensureProfile：默认名由调用方给（随语言）', () => {
  assert.equal(ensureProfile({ version: 1, activeId: null, profiles: [] }, 'Player 1').profiles[0].name, 'Player 1');
  assert.equal(ensureProfile({ version: 1, activeId: null, profiles: [] }, tFor('zh')('profiles.defaultName', { n: 1 })).profiles[0].name, '玩家 1');
  assert.equal(tFor('en')('profiles.defaultName', { n: 3 }), 'Player 3');
});

test('ensureProfile：已有档案名是用户内容，不改', () => {
  const s = { version: 1, activeId: 'a', profiles: [{ id: 'a', name: '玩家 1' }] };
  assert.equal(ensureProfile(s, 'Player 1').profiles[0].name, '玩家 1');
});

test('createProfile：空名用 defaultName，非空名原样（去空白）', () => {
  const s0 = { version: 1, activeId: null, profiles: [] };
  assert.equal(createProfile(s0, '  ', 'Player 1').profiles[0].name, 'Player 1');
  assert.equal(createProfile(s0, ' 小明 ', 'Player 1').profiles[0].name, '小明');
});

test('importProfile：坏码 / 坏版本抛带 code 的错误，errorText 按语言出具体原因', () => {
  const s = { version: 1, activeId: null, profiles: [] };
  let e1; try { importProfile(s, '@@@'); } catch (e) { e1 = e; }
  assert.ok(e1 instanceof Error);
  assert.equal(e1.code, 'err.profileCode');
  const wrong = btoa(JSON.stringify({ v: 2, games: {} }));
  let e2; try { importProfile(s, wrong); } catch (e) { e2 = e; }
  assert.equal(e2.code, 'err.profileVersion');
  assert.equal(errorText(e1, tFor('zh')), '存档码无法识别，请确认复制完整');
  assert.equal(errorText(e2, tFor('zh')), '存档码版本不支持');
  assert.doesNotMatch(errorText(e1, tFor('en')), /[一-鿿]/);
  assert.doesNotMatch(errorText(e2, tFor('en')), /[一-鿿]/);
  assert.notEqual(errorText(e1, tFor('en')), tFor('en')('err.unknown'));
});

test('importProfile：导出再导入，后缀随语言，原名不动', () => {
  const s = createProfile({ version: 1, activeId: null, profiles: [] }, '小明', 'Player 1');
  const code = exportProfile(s.activeId, s.profiles);
  const en = tFor('en');
  const next = importProfile(s, code, (n) => en('profiles.imported', { name: n }));
  assert.equal(next.profiles[1].name, '小明 (imported)');
  const zh = tFor('zh');
  assert.equal(importProfile(s, code, (n) => zh('profiles.imported', { name: n })).profiles[1].name, '小明（导入）');
});

test('errorText：非 err. 开头的本地 code 不被当成译文键', () => {
  const e = Object.assign(new Error('x'), { code: 'ENOENT' });
  assert.equal(errorText(e, tFor('en')), tFor('en')('err.unknown'));
});
