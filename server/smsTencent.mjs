/**
 * 腾讯云短信 SendSms（API 3.0，TC3-HMAC-SHA256 自签，不引 SDK）。
 * 密钥只由调用方从环境变量传入；任何错误文本都不带密钥。
 */
import crypto from 'node:crypto';
import { maskPhone } from './phone.mjs';

const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest();

/** 生成完整请求头（含 Authorization）。timestamp 为秒。 */
export function tc3Sign({ secretId, secretKey, service, host, action, version, region, timestamp, payload }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // UTC 日期
  const contentType = 'application/json; charset=utf-8';
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = [
    'POST', '/', '',
    `content-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`,
    signedHeaders,
    sha256Hex(payload),
  ].join('\n');
  const scope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256Hex(canonicalRequest)}`;
  const kSigning = hmac(hmac(hmac(`TC3${secretKey}`, date), service), 'tc3_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'Content-Type': contentType,
    Host: host,
    'X-TC-Action': action,
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Version': version,
    'X-TC-Region': region,
  };
}

const HOST = 'sms.tencentcloudapi.com';

export function createTencentSender({
  secretId, secretKey, sdkAppId = '1400683809', signName = '上海磊宁科技有限公司', templateId = '1417875',
  region = 'ap-guangzhou', param2 = '5', fetchImpl = fetch, nowSec = () => Math.floor(Date.now() / 1000), timeoutMs = 8000,
}) {
  const cleanWith = (e164) => (t) => {
    let s = String(t);
    for (const secret of [secretKey, secretId]) if (secret) s = s.split(secret).join('***');
    // 纵深防御：外部错误文本可能回显完整号码
    for (const n of [e164, String(e164).replace(/^\+/, '')]) if (n) s = s.split(n).join(maskPhone(e164));
    return s.slice(0, 200);
  };
  return {
    id: 'tencent',
    async send(e164, code) {
      const clean = cleanWith(e164);
      const payload = JSON.stringify({
        PhoneNumberSet: [e164], SmsSdkAppId: sdkAppId, SignName: signName, TemplateId: templateId,
        TemplateParamSet: param2 === '' ? [code] : [code, param2],
      });
      const headers = tc3Sign({
        secretId, secretKey, service: 'sms', host: HOST, action: 'SendSms', version: '2021-01-11',
        region, timestamp: nowSec(), payload,
      });
      let data;
      let httpStatus = '?';
      try {
        const res = await fetchImpl(`https://${HOST}/`, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
        httpStatus = res.status;
        data = await res.json();
      } catch (e) {
        const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        return { ok: false, error: timedOut ? 'tencent timeout' : clean(`tencent network: ${e?.message ?? e}`) };
      }
      const r = data?.Response;
      if (r?.Error) return { ok: false, error: clean(`${r.Error.Code ?? 'Error'}: ${r.Error.Message ?? ''}`) };
      const st = r?.SendStatusSet?.[0];
      if (!st) return { ok: false, error: `tencent: HTTP ${httpStatus} 响应缺少 SendStatusSet` };
      if (st.Code !== 'Ok') return { ok: false, error: clean(`${st.Code}: ${st.Message ?? ''}`) };
      return { ok: true, providerId: st.SerialNo ?? r.RequestId };
    },
  };
}
