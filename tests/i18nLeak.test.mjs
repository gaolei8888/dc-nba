import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findCjk, scanFiles, migratedFiles, loadAllowlist } from '../scripts/check-i18n.mjs';

test('findCjk：忽略注释，命中字符串、模板与 JSX 文本', () => {
  assert.deepEqual(findCjk('// 注释\n/* 块 */\nconst a = 1;'), []);
  assert.deepEqual(findCjk('/* 多行\n注释 */\nconst a = 1;'), []);
  assert.equal(findCjk("const u = 'https://x.cn/球队';").length, 1);
  assert.equal(findCjk('const s = `第 ${n} 场`;').length, 1);
  assert.equal(findCjk('<p>{/* 说明 */}今日比赛</p>').length, 1);
  assert.deepEqual(findCjk("t('today.title')").map((x) => x.line), []);
});

test('findCjk：行号正确，行尾注释不算，撇号不吞后续行', () => {
  assert.deepEqual(findCjk("a();\nconst x = 1; // 说明\n<p>don't</p>\n<b>中文</b>").map((x) => x.line), [4]);
});

test('scanFiles：命中返回文件与行号，白名单子串放行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cjk-'));
  const f = path.join(dir, 'a.js');
  fs.writeFileSync(f, "const a = 1;\nconst b = '中文';\nconst c = '[dev] 开发提示';\n");
  const all = scanFiles([f], {});
  assert.deepEqual(all.map((x) => x.line), [2, 3]);
  const rel = path.relative(path.resolve('.'), f);
  assert.deepEqual(scanFiles([f], { [rel]: ['[dev]'] }).map((x) => x.line), [2]);
});

test('已迁移文件没有残留中文（白名单除外）', () => {
  const files = migratedFiles();
  assert.ok(files.includes('web/src/App.jsx'));
  const left = scanFiles(files, loadAllowlist());
  assert.deepEqual(left, [], left.map((x) => `${x.file}:${x.line} ${x.text}`).join('\n'));
});

test('format.js 不再导出中文 / 北京时间专用函数', async () => {
  const m = await import('../web/src/lib/format.js');
  for (const k of ['CONF_CN', 'DIV_CN', 'DIV_ORDER', 'MONTH_CN', 'WEEKDAY', 'fmtDate', 'fmtDateFull', 'bjToday', 'bjDateOf', 'bjTimeOf', 'restLabel', 'snapshotAge'])
    assert.equal(m[k], undefined, `${k} 还在`);
});

test('migrated.json 为 "*"，全站 JS/JSX 都在扫描范围', () => {
  assert.ok(migratedFiles().includes('web/src/lib/format.js'));
  assert.ok(migratedFiles().includes('web/src/pages/Lab.jsx'));
});
