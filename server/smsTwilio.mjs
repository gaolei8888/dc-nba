/**
 * Twilio Verify（验证码由 Twilio 生成并校验，我们不存码）。
 * 凭据只由调用方从环境变量传入；错误文本不带凭据。
 */
export function createTwilioVerifySender({ accountSid, authToken, serviceSid, fetchImpl = fetch, timeoutMs = 8000 }) {
  const base = `https://verify.twilio.com/v2/Services/${serviceSid}`;
  const auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

  async function post(path, form) {
    const res = await fetchImpl(`${base}/${path}`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let data = null;
    try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
    return { status: res.status, data };
  }
  const netErr = (e) => (e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'twilio timeout' : 'twilio network error');

  return {
    id: 'twilio',
    ownsCode: true,
    async send(e164) {
      try {
        const { status, data } = await post('Verifications', { To: e164, Channel: 'sms' });
        if (status >= 200 && status < 300 && data?.status === 'pending') return { ok: true, providerId: data.sid };
        return { ok: false, error: `twilio HTTP ${status}${data?.code ? ` code ${data.code}` : ''}` };
      } catch (e) {
        return { ok: false, error: netErr(e) };
      }
    },
    async check(e164, code) {
      try {
        const { status, data } = await post('VerificationCheck', { To: e164, Code: code });
        if (status >= 200 && status < 300 && data?.status === 'approved') return { ok: true };
        return { ok: false, error: `twilio HTTP ${status} status ${data?.status ?? '?'}` };
      } catch (e) {
        return { ok: false, error: netErr(e) };
      }
    },
  };
}
