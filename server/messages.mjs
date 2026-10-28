// 服务端消息码：用户可见的错误与说明不再直接发中文给前端渲染，
// 而是发稳定的 { code, params }，由前端按当前语言翻译。
// 中文 error 字段仍保留在响应里，只给日志、脚本和 curl 排查用。
// 通用机制：登录 / 短信等后续错误也沿用 sendError + err.* 码。

/** 构造一条可翻译消息 */
export const msg = (code, params = {}) => ({ code, params });

/** 带码的 Error：message 是中文（日志用），code/params 给客户端 */
export function codedError(code, zhMessage, params = {}) {
  const e = new Error(zhMessage);
  e.code = code;
  e.params = params;
  return e;
}

/**
 * 统一错误响应：{ error: 中文, code, params, ...extra }。
 * extra 用来带 reason / log 等既有字段（不得覆盖 error / code / params）。
 */
export function sendError(res, status, code, zhMessage, params = {}, extra = {}) {
  return res.status(status).json({ ...extra, error: zhMessage, code, params });
}

/** wrap 捕获到异常时决定对外的码：只有 err. 开头的才转发，Node 内部码（ENOENT 等）一律 err.internal */
export function publicCode(e) {
  return typeof e?.code === 'string' && e.code.startsWith('err.') ? e.code : 'err.internal';
}
