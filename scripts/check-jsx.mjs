/**
 * 检查 JSX 里用到的组件是不是都能解析到。
 *
 * 起因：Profiles.jsx 用了 <Loading /> 但忘了 import，vite build 完全不报错，
 * 打开页面才白屏（ReferenceError: Loading is not defined）。
 * 项目没有配 ESLint，这个脚本补上最要紧的那一条 no-undef。
 *
 *   npm run check
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const SRC = path.join(ROOT, 'web', 'src');

/** 递归收集 .jsx / .js */
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : (/\.jsx?$/.test(e.name) ? [p] : []);
  });
}

/** 从 import 语句里取出所有绑定名（含具名、默认、命名空间） */
function importedNames(src) {
  const names = new Set();
  const re = /import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const clause = m[1];
    // { A, B as C }
    const braced = clause.match(/\{([\s\S]*?)\}/);
    if (braced) {
      for (const part of braced[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) names.add(name);
      }
    }
    // 默认导入与命名空间导入
    const head = clause.replace(/\{[\s\S]*?\}/, '').replace(/,/g, ' ').trim();
    for (const tok of head.split(/\s+/)) {
      const t = tok.replace(/^\*$/, '').replace(/^as$/, '').trim();
      if (t && /^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  return names;
}

/** 文件内自己定义的（function Foo / const Foo = / class Foo） */
function localNames(src) {
  const names = new Set();
  const res = [
    /(?:export\s+)?(?:default\s+)?function\s+([A-Z][\w$]*)/g,
    /(?:export\s+)?(?:const|let|var)\s+([A-Z][\w$]*)\s*=/g,
    /(?:export\s+)?class\s+([A-Z][\w$]*)/g,
  ];
  for (const re of res) {
    let m;
    while ((m = re.exec(src))) names.add(m[1]);
  }
  return names;
}

/** JSX 里以大写开头的标签就是组件引用 */
function usedComponents(src) {
  const names = new Set();
  const re = /<([A-Z][\w$]*)[\s/>]/g;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  return names;
}

let problems = 0;
for (const file of walk(SRC)) {
  const src = fs.readFileSync(file, 'utf8');
  const known = new Set([...importedNames(src), ...localNames(src), 'React', 'Fragment']);
  for (const c of usedComponents(src)) {
    if (!known.has(c)) {
      console.error(`  ${path.relative(ROOT, file)}: <${c}> 未 import 也未在本文件定义`);
      problems += 1;
    }
  }
}

if (problems) {
  console.error(`\n发现 ${problems} 处未解析的组件引用。这类问题 vite build 不会报错，但打开页面会白屏。`);
  process.exit(1);
}
console.log('JSX 组件引用检查通过');
