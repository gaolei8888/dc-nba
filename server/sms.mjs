/**
 * 短信发送器选择。密钥只从环境变量读，不打印。
 *
 * @typedef {object} SmsSender
 * @property {string} id
 * @property {boolean} [ownsCode]  true：验证码由服务商生成（Twilio Verify），send 收到 null，校验走 check
 * @property {(e164: string, code: string | null) => Promise<{ok: true, providerId: string} | {ok: false, error: string}>} send
 * @property {(e164: string, code: string) => Promise<{ok: boolean, error?: string}>} [check]
 */
import { isMainland, maskPhone } from './phone.mjs';
import { createTencentSender } from './smsTencent.mjs';
import { createTwilioVerifySender } from './smsTwilio.mjs';

/** 开发用：把验证码打到控制台（仅非 production 由 createSenders 启用） */
export function consoleSender(log = console) {
  return {
    id: 'console',
    async send(e164, code) {
      log.log(`[sms:console] ${maskPhone(e164)} 验证码 ${code}`);
      return { ok: true, providerId: 'console' };
    },
  };
}

/** 未配置 / 关闭：如实失败，不假装发了 */
export function disabledSender(reason) {
  return { id: 'disabled', async send() { return { ok: false, error: reason }; } };
}

const opt = (v) => (typeof v === 'string' && v !== '' ? v : undefined);

export function createSenders(env = process.env, { fetchImpl = fetch, log = console } = {}) {
  const prod = env.NODE_ENV === 'production';
  const hasTencent = !!(env.TENCENT_SMS_SECRET_ID && env.TENCENT_SMS_SECRET_KEY);
  const provider = env.SMS_PROVIDER;

  let mainland;
  let mainlandDesc;
  if (provider === 'disabled') {
    mainland = disabledSender('短信已关闭（SMS_PROVIDER=disabled）');
    mainlandDesc = 'disabled';
  } else if (provider === 'console' && !prod) {
    mainland = consoleSender(log);
    mainlandDesc = 'console';
  } else if (hasTencent) {
    mainland = createTencentSender({
      secretId: env.TENCENT_SMS_SECRET_ID,
      secretKey: env.TENCENT_SMS_SECRET_KEY,
      sdkAppId: opt(env.TENCENT_SMS_SDK_APP_ID),
      signName: opt(env.TENCENT_SMS_SIGN_NAME),
      templateId: opt(env.TENCENT_SMS_TEMPLATE_ID),
      region: opt(env.TENCENT_SMS_REGION),
      // 空字符串是合法值（模板只有一个参数），所以只在未设置时用默认
      param2: env.TENCENT_SMS_PARAM2,
      fetchImpl,
    });
    mainlandDesc = 'tencent';
  } else {
    mainland = disabledSender('未配置短信通道（缺 TENCENT_SMS_SECRET_ID / TENCENT_SMS_SECRET_KEY）');
    mainlandDesc = 'disabled（未配置腾讯云密钥）';
  }

  const twilioOk = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID);
  const overseasOn = env.ENABLE_OVERSEAS_SMS === '1' && twilioOk;
  const overseas = overseasOn
    ? createTwilioVerifySender({
      accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN,
      serviceSid: env.TWILIO_VERIFY_SERVICE_SID, fetchImpl,
    })
    : null;
  const overseasDesc = overseasOn ? 'twilio'
    : env.ENABLE_OVERSEAS_SMS === '1' ? '关闭（缺 Twilio 变量）' : '关闭';

  return { mainland, overseas, overseasOn, describe: { mainland: mainlandDesc, overseas: overseasDesc } };
}

export function pickSender(senders, e164) {
  if (isMainland(e164)) return { sender: senders.mainland };
  if (senders.overseasOn && senders.overseas) return { sender: senders.overseas };
  return { code: 'auth.overseasClosed' };
}
