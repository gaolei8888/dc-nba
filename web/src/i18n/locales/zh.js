export default {
  meta: { name: '中文', short: '中文', intl: 'zh-CN', htmlLang: 'zh-CN', defaultTz: 'Asia/Shanghai', match: ['zh'] },
  common: { loading: '加载中…', noData: '暂无数据', clear: '清除' },
  fmt: {
    date: '{mon}{d}日 {wd}',
    dateFull: '{y}年{mon}{d}日 {wd}',
    dateMD: '{mon}{d}日',
    dateShort: '{m}/{d}',
    month: '{mon}',
    timeZoned: '{time} {zone}',
    teamNameField: 'cn',
    rest: { b2b: '背靠背', days: { other: '休{count}天' } },
    age: { now: '刚刚抓取', hours: { other: '{count} 小时前抓取' }, days: { other: '{count} 天前抓取' } },
  },
  tz: { et: '美东时间', bj: '北京时间' },
  team: {
    conf: { East: '东部', West: '西部' },
    div: { Atlantic: '大西洋', Central: '中部', Southeast: '东南', Northwest: '西北', Pacific: '太平洋', Southwest: '西南' },
    pos: { G: '后卫', F: '前锋', C: '中锋', 'G-F': '后卫/前锋', 'F-G': '前锋/后卫', 'F-C': '前锋/中锋', 'C-F': '中锋/前锋' },
  },
};
