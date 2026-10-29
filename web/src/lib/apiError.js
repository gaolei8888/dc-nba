// 接口错误：保留状态码与机器可读的 code，界面按 code 翻译。
// 服务端 body.error 的中文原文只放在 message 里供日志排查，永远不显示给用户。
// 单独成文件（不依赖 import.meta.env），便于 node 直接测试。
// `body` 可能含图形验证载荷（captcha.id / image）——绝不整体打印到日志或原样显示，只按需取字段。

export class ApiError extends Error {
  constructor({ status, code = null, params = {}, message = '', body = null }) {
    super(message || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.params = params ?? {};
    // 完整响应体：登录流程要从 428/400 里取图形验证（body.captcha）
    this.body = body;
  }
}

/** 从失败的 Response 构造 ApiError；body 读不出来就只有状态码 */
export async function toApiError(res) {
  const body = await res.json().catch(() => ({}));
  return new ApiError({
    status: res.status,
    code: typeof body?.code === 'string' ? body.code : null,
    params: body?.params && typeof body.params === 'object' ? body.params : {},
    message: typeof body?.error === 'string' ? body.error : '',
    body: body && typeof body === 'object' && Object.keys(body).length ? body : null,
  });
}

/** 把任意错误变成当前语言的提示文案。找不到译文时用通用文案，绝不返回服务端原文。 */
export function errorText(err, t) {
  if (err instanceof ApiError) {
    if (err.code) {
      const s = t(err.code, err.params);
      // core 对缺键返回键名本身
      if (s && s !== err.code) return s;
    }
    return t('err.http', { status: err.status });
  }
  // 前端本地错误（如存档码无法识别）：自带 err.* 形式的 code
  if (typeof err?.code === 'string' && err.code.startsWith('err.')) {
    const s = t(err.code, err.params);
    if (s && s !== err.code) return s;
  }
  // 未知错误只记日志，不当成网络错误（TypeError 也可能是代码缺陷）
  console.error(err);
  return t('err.unknown');
}
