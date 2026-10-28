// 渲染服务端消息码 { code, params }：纯函数，node 可直接导入。
// params 里只有数字、日期、teamId 与嵌套消息；语言相关的格式全在 t 的格式化器里
// （team：teamId → 当前语言队名；msg：嵌套消息递归渲染）。
import { createT } from './core.js';

const isMsg = (m) => m && typeof m === 'object' && typeof m.code === 'string';

/**
 * @param {object|object[]|string|null} m  一条消息、消息数组，或旧接口的纯字符串（原样返回）
 * @param {Function} t  createMsgT 建的 t（已带 msg 格式化器）
 * 数组按语言用 common.sentenceJoin 连接（中文无分隔，英文空格）。
 */
export function renderMsg(m, t) {
  if (m == null) return '';
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map((x) => renderMsg(x, t)).join(t('common.sentenceJoin'));
  if (!isMsg(m)) return '';
  return t(m.code, m.params ?? {});
}

/**
 * createT 加上 msg 格式化器（{verdict, msg} 这类嵌套消息）。
 * msg 闭包里引用的是返回的 t 本身，调用时才取值，没有构造顺序上的循环。
 */
export function createMsgT({ formatters = {}, ...opts }) {
  const t = createT({ ...opts, formatters: { ...formatters, msg: (v) => renderMsg(v, t) } });
  return t;
}

/**
 * 阵容先验说明：行上的 impactSource 作码后缀（srv.roster.source.<impactSource>），
 * 「收缩到什么」按 sourceParams.targetKind 取 srv.roster.target.<targetKind>。实测来源没有说明，返回 null。
 */
export function rosterSourceMsg(p) {
  if (!p?.impactPrior || typeof p.impactSource !== 'string') return null;
  const sp = p.impactPrior.sourceParams;
  const code = `srv.roster.source.${p.impactSource}`;
  if (!sp) return { code, params: {} };
  return { code, params: { ...sp, what: { code: `srv.roster.target.${sp.targetKind}`, params: {} } } };
}
