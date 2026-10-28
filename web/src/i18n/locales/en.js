export default {
  meta: { name: 'English', short: 'EN', intl: 'en-US', htmlLang: 'en', defaultTz: 'America/New_York', match: ['en'] },
  common: { loading: 'Loading…', noData: 'No data', clear: 'Clear' },
  fmt: {
    date: '{wd}, {mon} {d}',
    dateFull: '{wd}, {mon} {d}, {y}',
    dateMD: '{mon} {d}',
    dateShort: '{m}/{d}',
    month: '{mon}',
    timeZoned: '{time} {zone}',
    teamNameField: 'full',
    rest: { b2b: 'B2B', days: { one: '{count} day rest', other: '{count} days rest' } },
    age: { now: 'fetched just now', hours: { one: 'fetched {count} hour ago', other: 'fetched {count} hours ago' }, days: { one: 'fetched {count} day ago', other: 'fetched {count} days ago' } },
  },
  tz: { et: 'ET', bj: 'Beijing' },
  team: {
    conf: { East: 'East', West: 'West' },
    div: { Atlantic: 'Atlantic', Central: 'Central', Southeast: 'Southeast', Northwest: 'Northwest', Pacific: 'Pacific', Southwest: 'Southwest' },
    pos: { G: 'Guard', F: 'Forward', C: 'Center', 'G-F': 'Guard-Forward', 'F-G': 'Forward-Guard', 'F-C': 'Forward-Center', 'C-F': 'Center-Forward' },
  },
};
