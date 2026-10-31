#!/usr/bin/env node
// 对本地运行中的 Worker（npx wrangler dev）批量查询若干 IP 并输出结果表
// 用法：node scripts/smoke-test.mjs [baseUrl] [ip ...]
const base = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://127.0.0.1:8787';
const args = process.argv.slice(process.argv[2]?.startsWith('http') ? 3 : 2);
const DEFAULT = [
  ['8.8.8.8', 'Google DNS'], ['1.1.1.1', 'Cloudflare DNS'], ['3.5.140.2', 'AWS'], ['47.88.0.1', '阿里云 (US)'],
  ['39.96.0.1', '阿里云 (北京)'], ['119.28.0.1', '腾讯云 (HK)'], ['49.234.0.1', '腾讯云'], ['114.222.1.1', '中国电信'],
  ['180.110.1.1', '中国电信'], ['221.218.0.1', '中国联通'], ['112.224.0.1', '中国联通'], ['117.136.0.1', '中国移动'],
  ['120.204.0.1', '中国移动'], ['73.0.0.1', 'Comcast'], ['5.9.0.1', 'Hetzner'], ['2001:4860:4860::8888', 'Google v6'],
  // 嵌套 / 重叠段（旧实现只回扫 64 段会漏检）
  ['34.190.0.1', 'Google 34.128.0.0/10'], ['34.183.219.127', 'Google /10 内，旧版漏检'], ['34.186.0.1', 'GCP 段嵌套在 Google /10 内'],
];
let list = args.length ? args.map((a) => [a, '']) : DEFAULT;
if (!args.length) {
  const tor = (await import('../src/data/tor-exits.json', { with: { type: 'json' } })).default.ips.find((x) => !x.includes(':'));
  list.push([tor, 'Tor 出口(列表第一个 v4)']);
}
const rows = [];
for (const [ip, note] of list) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/api/ip?ip=${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(30000) });
    const d = await r.json();
    if (!d.ok) { rows.push({ ip, note, error: d.message }); continue; }
    const a = d.analysis;
    rows.push({ ip, note, asn: d.network.asn ? `AS${d.network.asn}` : '-', org: (d.network.org || '').slice(0, 28),
      loc: [d.location.countryCode, d.location.region].filter(Boolean).join('/'), type: a.typeText, conf: a.confidenceText, score: a.score, risk: a.riskText,
      cloud: d.network.cloudProvider.join('+') || '-', inc: a.incomplete ? '是' : '否',
      signals: a.signals.filter((s) => s.effect).map((s) => `${s.name}${s.effect > 0 ? '+' : ''}${s.effect}`).join('; ') || '-',
      geo: d.sources.geo, ptr: d.network.ptr || '-', ms: Date.now() - t0 });
  } catch (e) { rows.push({ ip, note, error: String(e.message || e) }); }
}
console.log('| IP | 备注 | ASN | 组织 | 位置 | 云厂商段 | 类型 | 置信度 | 分数 | 风险 | 不完整 | 主要信号 | PTR | 地理来源 | ms |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(r.error ? `| ${r.ip} | ${r.note} | 错误：${r.error} |` :
  `| ${r.ip} | ${r.note} | ${r.asn} | ${r.org} | ${r.loc} | ${r.cloud} | ${r.type} | ${r.conf} | ${r.score} | ${r.risk} | ${r.inc} | ${r.signals} | ${r.ptr} | ${r.geo} | ${r.ms} |`);
