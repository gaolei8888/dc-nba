import React from 'react';
import { useI18n } from '../i18n/react.jsx';
import zh from '../legal/zh.js';
import en from '../legal/en.js';

// 加一种语言 = 在 legal/ 加一个文件并在此登记；缺失的语言回退中文
const DOCS = { zh, en };

/** 《用户协议》/《隐私政策》：doc 为 'terms' 或 'privacy'。正文里的版本号与更新日期来自 legal 文件 */
export default function Legal({ doc }) {
  const { lang, t } = useI18n();
  const pack = DOCS[lang] ?? DOCS.zh;
  const body = pack[doc] ?? DOCS.zh[doc];
  return (
    <div className="legal-page">
      <div className="page-head">
        <h1>{body.title}</h1>
        <p>{t('legal.meta', { version: pack.version, date: pack.updated })}</p>
      </div>
      <div className="card legal-body">
        {body.sections.map((s) => (
          <section key={s.h}>
            <h2>{s.h}</h2>
            {s.p.map((x, i) => <p key={i}>{x}</p>)}
          </section>
        ))}
      </div>
    </div>
  );
}
