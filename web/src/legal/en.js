// DRAFT, pending review by Gao Lei. English version of the Terms of Service and Privacy Policy.
// Every "[TO BE FILLED BY OWNER ...]" below is a placeholder that must be completed or confirmed before launch.
// Drafted from what the product actually does today; have counsel review the legal wording.
export default {
  version: '2026-10-29',
  updated: '2026-10-29',
  terms: {
    title: 'Terms of Service',
    sections: [
      {
        h: '1. The service',
        p: [
          'This site is operated by Shanghai Leining Technology Co., Ltd. ("we"). It shows NBA schedules, data and model predictions, plus features such as "You vs. the Model" and paper betting.',
          'Everything here is for entertainment, learning and research only. It is not betting, investment or any other kind of advice. Model predictions can be wrong, and past performance does not predict future results.',
          'Paper betting and "You vs. the Model" are virtual records. No real money is involved, and we do not offer, broker or arrange any real gambling or wagering.',
          'The site currently has no paid features and no ads.',
        ],
      },
      {
        h: '2. Your account',
        p: [
          'You sign in or sign up with a phone number and a text-message code. There is no password, and a new number is registered once its code is verified. One phone number is one account.',
          'Keep your phone and any signed-in devices safe. Actions taken through your device or code are treated as yours.',
          'Most features work without signing in. Signing in lets you sync your player profile and record across devices and see the full scorecard statistics and paper betting.',
          'You must be at least [TO BE FILLED BY OWNER: minimum age, e.g. 18]. Do not register if you are younger.',
        ],
      },
      {
        h: '3. Acceptable use',
        p: [
          'You may not: register accounts in bulk; use scripts or programs to hammer the API or request codes in bulk; scrape or copy site data for commercial use; disrupt the service; or use the site for anything unlawful.',
          'We may restrict, suspend or end service to accounts or network addresses that break these rules.',
        ],
      },
      {
        h: '4. Membership tiers',
        p: [
          'Every account is on the free tier today. If we ever introduce paid plans, we will tell you in advance and they will only apply after you agree to them separately. These Terms are not advance consent to future charges.',
        ],
      },
      {
        h: '5. Disclaimers and limits of liability',
        p: [
          'The site is provided "as is". Data comes from third-party public sources and may be late, missing or wrong. We do not promise the service will be uninterrupted or error-free.',
          'To the extent the law allows, we are not liable for any loss arising from using or being unable to use the site, including any decision you make based on its predictions. Mandatory legal provisions to the contrary still apply.',
          '[TO BE FILLED BY OWNER: whether a liability cap or other clauses are needed; confirm with counsel]',
        ],
      },
      {
        h: '6. Changes to these Terms',
        p: [
          'We may update these Terms. Material changes will be announced prominently on the site, and continuing to use the site means you accept the updated Terms. Where your fresh consent is required, we will ask for it again when you sign in.',
        ],
      },
      {
        h: '7. Governing law and disputes',
        p: [
          'These Terms are governed by the laws of the People\'s Republic of China. The parties will first try to resolve any dispute through friendly negotiation; failing that, it goes to [TO BE FILLED BY OWNER: court with jurisdiction, e.g. the competent people\'s court where Shanghai Leining Technology Co., Ltd. is located].',
        ],
      },
      {
        h: '8. Contact',
        p: [
          'Operator: Shanghai Leining Technology Co., Ltd.',
          'Email: [TO BE FILLED BY OWNER: contact email]',
          'Address: [TO BE FILLED BY OWNER: company address]',
        ],
      },
    ],
  },
  privacy: {
    title: 'Privacy Policy',
    sections: [
      {
        h: '1. What we collect',
        p: [
          'Sign-up and sign-in: your phone number (with its country or region code), when you registered and when you last signed in.',
          'Sign-in security: a log of text-message codes sent (phone number, send time and result) and the network (IP) address that requested the code. Image-check answers are kept only as hashes in server memory and are never written to disk.',
          'Sessions: a session token created when you sign in. The server stores only its hash. It lasts 30 days and stops working when you sign out.',
          'Player data: the player name you choose, your predictions in "You vs. the Model" and your leaderboard results. Without an account, this exists as an anonymous player.',
          'Preferences: the interface language and time zone you pick.',
          'Your browser\'s local storage (localStorage) holds your session, local player profiles and preferences. That stays on your device.',
          'We do not collect your contacts, location, photos or call history. We use no third-party analytics or ad tools, and we show you no ads.',
        ],
      },
      {
        h: '2. Why we collect it',
        p: [
          'Phone number: to verify who you are, sign you in and let you recover your account.',
          'Sign-in records, send logs and IP addresses: to prevent API abuse, bulk sign-ups and text-message abuse, to keep the service secure and to track text-message volume.',
          'Player data and preferences: to run "You vs. the Model" and the leaderboard, and, once you sign in, to sync your record across devices and keep your language and time zone.',
          'We process this information because it is necessary to provide the service to you, and on the basis of your consent to this policy before you sign in.',
        ],
      },
      {
        h: '3. SMS providers and cross-border transfer',
        p: [
          'To send a code, we pass your phone number and the message content to an SMS provider: Tencent Cloud SMS for mainland China numbers.',
          'Sign-in with overseas numbers is not open yet. When it opens, codes will be sent through Twilio Verify and your phone number will be transferred outside China. Before that, we will update this policy and separately notify you of the transfer and ask for your consent. [TO BE FILLED BY OWNER: before overseas numbers open, add the overseas recipient\'s name, contact details, purpose and method of processing, and other legally required notices]',
        ],
      },
      {
        h: '4. Where it is stored and for how long',
        p: [
          'Your information is stored on servers located in the People\'s Republic of China.',
          'Account information: kept while your account exists, and deleted or anonymized after the account is closed.',
          'Text-message send logs: kept for 180 days. [TO BE FILLED BY OWNER: confirm the retention period and whether an automatic cleanup job exists]',
          'Session tokens: expire after 30 days or when you sign out. [TO BE FILLED BY OWNER: how often expired session records are cleaned up]',
          'Sign-in IP and other security records: [TO BE FILLED BY OWNER: retention period]',
        ],
      },
      {
        h: '5. Sharing and disclosure',
        p: [
          'We do not sell your personal information and do not provide it to third parties, except: to the SMS provider above, as needed to send the text message; with your separate consent; or where laws or a competent authority require it.',
          'The leaderboard publicly shows your player name and results, never your phone number. Please do not use your phone number or other sensitive details as a player name.',
        ],
      },
      {
        h: '6. Your rights',
        p: [
          'You can access, copy and correct your personal information, withdraw your consent, or close your account.',
          'For now, account closure is handled manually through the contact details below. We will verify your identity and process it within [TO BE FILLED BY OWNER: response time, e.g. 15 business days]. [TO BE FILLED BY OWNER: whether a self-service account deletion feature will be offered]',
          'You can also sign out at any time and clear the local data in your browser.',
        ],
      },
      {
        h: '7. Minors',
        p: [
          'The site does not offer registration to minors. If you are under [TO BE FILLED BY OWNER: minimum age], please do not register. If we find that we collected a minor\'s information without a guardian\'s consent, we will delete it promptly.',
        ],
      },
      {
        h: '8. Changes to this policy',
        p: [
          'We may update this policy. Material changes will be announced prominently on the site, and we will ask for your consent again where required. This page shows the version number and the last-updated date.',
        ],
      },
      {
        h: '9. Contact us',
        p: [
          'Personal information handler: Shanghai Leining Technology Co., Ltd.',
          'Email: [TO BE FILLED BY OWNER: contact email]',
          'Address: [TO BE FILLED BY OWNER: company address]',
          'Personal information protection contact: [TO BE FILLED BY OWNER]',
        ],
      },
    ],
  },
};
