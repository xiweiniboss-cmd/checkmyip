#!/usr/bin/env node
// 规则测试：ASN / PTR 分类与评分（含“数据不完整”与信誉库提示）
import { classifyAsn, classifyPtr } from '../src/lib/asn.js';
import { analyze, INCOMPLETE_CAP } from '../src/lib/score.js';
let fails = 0, n = 0;
const eq = (name, got, exp) => { n++; if (JSON.stringify(got) !== JSON.stringify(exp)) { fails++; console.error(`✘ ${name}: 期望 ${JSON.stringify(exp)} 实际 ${JSON.stringify(got)}`); } };

// PTR（第 10 项）
const ptr = {
  'c-73-0-0-1.hsd1.il.comcast.net': 'residential', 'pool-71-1-2-3.nycmny.fios.verizon.net': 'residential',
  '1.1.222.114.broad.nj.js.dynamic.163data.com.cn': 'residential', '123.45.67.89.static.bjtelecom.net': 'static',
  'host-1-2-3-4.isp.net': null, 'ghost.example.org': null, 'localhost': null, 'dns.google': null, 'one.one.one.one': null,
  'vps123.example.com': 'datacenter', 'static.1.2.3.4.clients.your-server.de': 'datacenter',
  'ec2-3-1-2-3.compute-1.amazonaws.com': 'datacenter', 'srv-hosting.example.net': 'datacenter', 'cloudflare-dns.com': null,
};
for (const [p, exp] of Object.entries(ptr)) eq(`PTR ${p}`, classifyPtr(p).signal, exp);

const run = (asn, org, extra = {}) => {
  const asnInfo = classifyAsn(asn, org);
  return analyze({ cloud: [], asn: { asn, org }, asnInfo, ptr: extra.ptr || {}, tor: { tor: false, source: 'bundled', count: 1 }, external: [], quality: extra.quality || { geoOk: true, ptrOk: true } });
};
// 第 8 项：中国移动 → 家宽，置信度中
for (const a of [9808, 56048, 24400]) { const r = run(a, 'China Mobile'); eq(`AS${a} 类型`, [r.type, r.confidenceText], ['residential', '中']); }
// v0.3 第 6 项起：凡是按组织名关键词推测的类型，置信度一律「低」
eq('未收录编号的中国移动', [run(99999, 'China Mobile Communications Group Co., Ltd.').type, run(99999, 'China Mobile Communications Group Co., Ltd.').confidenceText], ['residential', '低']);
eq('中国电信 4134 仍为高置信', run(4134, 'CHINANET').confidenceText, '高');
eq('CN2 4809 仍为运营商（家宽 / 中）', [classifyAsn(4809).cls, run(4809, '').confidenceText], ['isp', '中']);
// 第 9 项：transit
for (const a of [174, 6939, 3356, 2914, 1299, 3257, 3491]) {
  const r = run(a, ''); eq(`AS${a} transit`, [classifyAsn(a).cls, r.type, r.score >= 80], ['transit', 'business', true]);
}
// 第 3 项：数据不完整
const inc = analyze({ asn: {}, asnInfo: classifyAsn(null, null), ptr: { error: 'x' }, tor: { tor: false, source: 'bundled', count: 1 }, external: [], quality: { geoOk: false, ptrOk: false } });
eq('全部失败', [inc.incomplete, inc.score <= INCOMPLETE_CAP, inc.risk !== 'low', inc.missing], [true, true, true, ['geo', 'asn', 'ptr']]);
const part = analyze({ asn: { asn: null, org: 'Some ISP' }, asnInfo: classifyAsn(null, 'Some Telecom'), ptr: {}, tor: { tor: false }, external: [], quality: { geoOk: true, ptrOk: true } });
eq('有位置但无 ASN', [part.incomplete, part.score <= 60, part.risk], [true, true, 'medium']);
// 第 7 项：信誉库提示
eq('无信誉库', [inc.reputation.used, !!inc.reputation.note], [false, true]);
const withRep = analyze({ asn: { asn: 4134 }, asnInfo: classifyAsn(4134), tor: {}, external: [{ source: 'abuseipdb', ok: true, abuseScore: 0 }], quality: { geoOk: true } });
eq('有信誉库', [withRep.reputation.used, withRep.reputation.note], [true, null]);

// v0.3 第 6 项：未知 ASN / 按名称推测
const q9 = run(19281, 'QUAD9-AS-1');
eq('Quad9 9.9.9.9 不是低风险', [classifyAsn(19281).cls, q9.type, q9.risk !== 'low'], ['hosting', 'datacenter', true]);
const unk = run(64999, 'Totally Unknown Org');
eq('未知 ASN：扣分加大、风险中、置信度低、有提示', [unk.score, unk.risk, unk.confidenceText, unk.signals.find((x) => x.key === 'asn').detail.includes('该 ASN 不在内置库中，类型按名称推测')], [75, 'medium', '低', true]);
const kwIsp = run(64998, 'Example Broadband Telecom');
const kwSig = kwIsp.signals.find((x) => x.key === 'asn');
eq('关键词推测：置信度低、提示、扣 5 分', [classifyAsn(64998, 'Example Broadband Telecom').by, kwIsp.confidenceText, kwSig.detail.includes('该 ASN 不在内置库中，类型按名称推测'), kwSig.effect], ['keyword', '低', true, -5]);
const kwHost = run(64997, 'Example Hosting Ltd');
eq('关键词推测机房：置信度低', [kwHost.type, kwHost.confidenceText], ['datacenter', '低']);
eq('内置 ASN 不受影响', [run(7922, 'Comcast').confidenceText, run(7922, 'Comcast').score], ['高', 100]);

console.log(`${fails ? '✘' : '✔'} 规则测试 ${n} 项，失败 ${fails} 项`);
process.exit(fails ? 1 : 0);
