// 已迁移文件的中文残留扫描：去掉注释后逐行找汉字（字符串、模板、JSX 文本都会命中）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CJK = /[㐀-䶿一-鿿＀-￯　-〿]/;

/** 去掉 // 与 块注释，保留换行；字符串里的 // 不算注释 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      else if (c === '\n' && quote !== '`') quote = null; // JSX 文本里的撇号不会吞掉后面所有行
      i += 1;
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
    } else {
      if (c === '"' || c === "'" || c === '`') quote = c;
      out += c;
      i += 1;
    }
  }
  return out;
}

export function findCjk(src) {
  const hits = [];
  stripComments(src).split('\n').forEach((text, idx) => {
    if (CJK.test(text)) hits.push({ line: idx + 1, text: text.trim() });
  });
  return hits;
}

/** allow：{ 文件: [允许出现的子串] }，该行含任一子串即放行 */
export function scanFiles(files, allow = {}) {
  const left = [];
  for (const file of files) {
    const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
    const rel = path.relative(ROOT, abs);
    const okSubs = allow[rel] || allow[file] || [];
    for (const h of findCjk(fs.readFileSync(abs, 'utf8'))) {
      if (okSubs.some((s) => h.text.includes(s))) continue;
      left.push({ file: rel, line: h.line, text: h.text });
    }
  }
  return left;
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.jsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

export function migratedFiles() {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/src/i18n/migrated.json'), 'utf8'));
  const files = list === '*' ? walk(path.join(ROOT, 'web/src')).map((p) => path.relative(ROOT, p)) : list;
  return files.filter((f) => !f.split(path.sep).join('/').startsWith('web/src/i18n/locales/'));
}

export function loadAllowlist() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'web/src/i18n/cjk-allowlist.json'), 'utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const left = scanFiles(migratedFiles(), loadAllowlist());
  if (left.length) {
    for (const x of left) console.log(`${x.file}:${x.line} ${x.text}`);
    process.exit(1);
  }
  console.log('i18n 中文残留检查通过');
}
