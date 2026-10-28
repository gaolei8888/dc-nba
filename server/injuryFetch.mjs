/**
 * 取官方伤病报告 PDF 的请求客户端（politeFetch）与 PDF -> 文本。历史回测（scripts/injury-history.mjs）
 * 与影子运行（scripts/shadow.mjs）共用同一套请求头与节奏。
 * 解析 PDF 用系统的 pdftotext（poppler，Docker 镜像里 apk 装），不引入 npm 依赖。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromeHeaders, createPoliteClient } from './politeFetch.mjs';

/** 像从 official.nba.com 的伤病报告页点开 PDF：顶层导航，不是 fetch。cfg 覆盖节奏、上限、状态文件 */
export function injuryClient(cfg = {}) {
  const { Origin, ...base } = chromeHeaders({ referer: 'https://official.nba.com/', origin: '' });
  return createPoliteClient({
    name: 'nba-injury',
    headers: {
      ...base,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', priority: 'u=0, i',
    },
    gapMs: [1500, 3000],
    pauseEvery: [25, 50],
    pauseMs: [5000, 15000],
    timeoutMs: 30000,
    ...cfg,
  });
}

/** politeFetch 的 parse：不是 PDF 就抛（按「内容不对」熔断） */
export const asPdf = (r) => {
  if (!r.bytes || r.bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('不是 PDF');
  return r.bytes;
};

/** PDF 文件路径或字节 -> `pdftotext -layout` 文本 */
export function pdfText(fileOrBytes) {
  if (!Buffer.isBuffer(fileOrBytes)) return execFileSync('pdftotext', ['-layout', fileOrBytes, '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'injury-'));
  try {
    fs.writeFileSync(path.join(tmp, 'r.pdf'), fileOrBytes);
    return pdfText(path.join(tmp, 'r.pdf'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
