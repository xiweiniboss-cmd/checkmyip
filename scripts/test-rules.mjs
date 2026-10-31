#!/usr/bin/env node
// 规则测试：ASN / PTR 分类与评分（含“数据不完整”与信誉库提示）
import { classifyAsn, classifyPtr, splitPtrLabels } from '../src/lib/asn.js';
import { analyze, INCOMPLETE_CAP, UNKNOWN_ASN_PENALTY, UNKNOWN_ASN_NOTE } from '../src/lib/score.js';
let fails = 0, n = 0;
const eq = (name, got, exp) => { n++; if (JSON.stringify(got) !== JSON.stringify(exp)) { fails++; console.error(`✘ ${name}: 期望 ${JSON.stringify(exp)} 实际 ${JSON.stringify(got)}`); } };

// PTR（第 10 项）
const ptr = {
  'c-73-0-0-1.hsd1.il.comcast.net': 'residential', 'pool-71-1-2-3.nycmny.fios.verizon.net': 'residential',
  '1.1.222.114.broad.nj.js.dynamic.163data.com.cn': 'residential', '123.45.67.89.static.bjtelecom.net': 'static',
  'host-1-2-3-4.isp.net': 'residential', 'ghost.example.org': null, 'localhost': null, 'dns.google': null, 'one.one.one.one': null,
  'vps123.example.com': 'datacenter', 'static.1.2.3.4.clients.your-server.de': 'datacenter',
  'ec2-3-1-2-3.compute-1.amazonaws.com': 'datacenter', 'srv-hosting.example.net': 'datacenter', 'cloudflare-dns.com': 'datacenter',
};
for (const [p, exp] of Object.entries(ptr)) eq(`PTR ${p}`, classifyPtr(p).signal, exp);

const run = (asn, org, extra = {}) => {
  const asnInfo = classifyAsn(asn, org);
  return analyze({ cloud: [], asn: { asn, org }, asnInfo, ptr: extra.ptr || {}, tor: { tor: false, source: 'bundled', count: 1 }, external: extra.external || [], quality: extra.quality || { geoOk: true, ptrOk: true } });
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
// v0.3.1：未知 ASN 只扣 10 分、附说明，且不单独抬高风险等级
eq('未知 ASN：扣 10 分、风险低、置信度低、有说明', [unk.score, unk.risk, unk.confidenceText, unk.type, unk.signals.find((x) => x.key === 'asn').effect, unk.signals.find((x) => x.key === 'asn').detail.includes(UNKNOWN_ASN_NOTE)], [90, 'low', '低', 'unknown', UNKNOWN_ASN_PENALTY, true]);
eq('UNKNOWN_ASN_PENALTY = -10', UNKNOWN_ASN_PENALTY, -10);
// 未知 ASN 再叠加一个 -5（静态 PTR）仍为低风险；叠加真正的坏信号（PTR 服务器类 -10 + 代理头 -15）才变中
const unkStatic = run(64999, 'Totally Unknown Org', { ptr: { ptr: 'static-1.example.net', signal: 'static', keyword: 'static' } });
eq('未知 ASN + 静态 PTR：85 / 低风险', [unkStatic.score, unkStatic.risk], [85, 'low']);
const unkBad = analyze({ cloud: [], asn: { asn: 64999, org: 'X' }, asnInfo: classifyAsn(64999, 'X'), ptr: { ptr: 'vps1.example.net', signal: 'datacenter', keyword: 'vps' }, tor: { tor: false }, external: [], proxyHeaders: ['Via'], quality: { geoOk: true, ptrOk: true } });
eq('未知 ASN 不计入风险，但其它坏信号照常生效（65 → 不计未知扣分 75 → 中）', [unkBad.score, unkBad.risk], [65, 'medium']);
// 真实家宽 PTR（Init7 / Sunrise / 常见写法）+ 未知 ASN → 家宽（低置信度），分数 95
const resPtrs = ['85-195-230-77.fiber7.init7.net', '77-57-100-20.dclient.hispeed.ch', 'adsl-84-226-12-34.adslplus.ch',
  'ppp-91-2-3-4.example.de', 'cable-1-2-3-4.example.ph', 'dsl-1-2-3-4.dynamic.example.net', 'dyn-203-0-113-7.example.de',
  'pool-1-2-3-4.example.com', 'dhcp-1-2-3-4.example.org', 'broadband-1-2.example.net', 'ftth-1-2-3-4.example.de',
  'customer-1-2-3-4.example.ch', '1-2-3-4.customers.example.ph', 'dynip-1-2-3-4.example.de', 'cablemodem-1.example.org'];
for (const p of resPtrs) {
  const c = classifyPtr(p);
  const r = run(64999, 'Totally Unknown Org', { ptr: { ptr: p, ...c } });
  eq(`未知 ASN + 家宽 PTR ${p}`, [c.signal, r.type, r.confidenceText, r.score, r.risk], ['residential', 'residential', '低', 95, 'low']);
}
// 服务器类词优先：即使同时带家宽词也判为服务器
for (const p of ['dsl-vps-1.example.net', 'customer-1.hosting.example.com', 'pool1.myvpsserver.example', 'cloud-ppp.example']) eq(`服务器词优先 ${p}`, classifyPtr(p).signal, 'datacenter');
// 不应误判为家宽
for (const p of ['dns9.quad9.net', 'r1win8.core.init7.net', 'mail.liverpool.example', 'router.blackpool.example', 'host.isp.net', 'webhost.isp.net']) eq(`非家宽 PTR ${p}`, classifyPtr(p).signal, null);
// Quad9 9.9.9.9：仍为机房，PTR 不影响
const q9p = run(19281, 'QUAD9-AS-1', { ptr: { ptr: 'dns9.quad9.net', ...classifyPtr('dns9.quad9.net') } });
eq('Quad9 + PTR dns9.quad9.net 仍为机房、非低风险', [q9p.type, q9p.risk !== 'low'], ['datacenter', true]);
const kwIsp = run(64998, 'Example Broadband Telecom');
const kwSig = kwIsp.signals.find((x) => x.key === 'asn');
eq('关键词推测：置信度低、提示、扣 5 分', [classifyAsn(64998, 'Example Broadband Telecom').by, kwIsp.confidenceText, kwSig.detail.includes('该 ASN 不在内置库中，类型按名称推测'), kwSig.effect], ['keyword', '低', true, -5]);
const kwHost = run(64997, 'Example Hosting Ltd');
eq('关键词推测机房：置信度低', [kwHost.type, kwHost.confidenceText], ['datacenter', '低']);
eq('内置 ASN 不受影响', [run(7922, 'Comcast').confidenceText, run(7922, 'Comcast').score], ['高', 100]);

// v0.3.2：家宽关键词按整词 / 可完整拆分的复合词匹配；服务 / 平台类词不判家宽
const negPtrs = { 'vpn-pool-1.example.net': null, 'vpn-pool-1-2-3-4.example.com': null, 'gke-prod-default-pool-1a2b3c.example.net': 'datacenter',
  'fiberhost-1.example.net': null, 'mx.dynect.net': null, 'mx1.dsl.example.net': null, 'proxy-7.pool.example.com': null,
  'node-12.dsl.example.net': null, 'mail.cable.example.org': null, 'smtp-out.customer.example.net': null,
  'k8s-worker-pool-3.example.io': 'datacenter', 'aks-nodepool1-123.example.net': 'datacenter', 'cluster-1.pool.example.net': 'datacenter',
  'my-cloud-pool.example': 'datacenter', 'fiberhosting.example.net': 'datacenter', 'serverpool.example.net': 'datacenter',
  'dynect.net': null, 'liverpool.example': null, 'clienthost.example': null, 'dslforum.example.org': null, 'poolside.example': null,
  'cdn-edge-1.pool.example': null, 'tor-exit.dsl.example': null };
for (const [p, exp] of Object.entries(negPtrs)) {
  const c = classifyPtr(p);
  eq(`家宽误判反例 ${p}`, c.signal, exp);
  const r = run(64999, 'Totally Unknown Org', { ptr: { ptr: p, ...c } });
  eq(`家宽误判反例 ${p} 不得 95 / 家宽`, [r.type === 'residential', r.score >= 95], [false, false]);
}
const posPtrs = { 'c-73-0-0-1.hsd1.il.comcast.net': 'hsd', '85-195-230-77.fiber7.init7.net': 'fiber', 'adsl-84-226-12-34.adslplus.ch': 'adsl',
  '77-57-100-20.dclient.hispeed.ch': 'client（dclient）', 'cablemodem-1.example.org': 'cable（cablemodem）', '1-2-3-4.customers.example.ph': 'customers',
  'ip-1-2-3-4.hsi03.unitymediagroup.de': 'hsi', 'pppoe-1-2-3-4.example.de': 'pppoe', 'xdsl-1-2.example.it': 'xdsl', 'dynamicip-1.example.net': 'dynamic（dynamicip）' };
for (const [p, kw] of Object.entries(posPtrs)) eq(`家宽正例 ${p}`, [classifyPtr(p).signal, classifyPtr(p).keyword], ['residential', kw]);
// v0.3.3：国家后缀不参与屏蔽；host+编号为运营商家宽写法；拆不开的粘连词按子串查机房 / 服务类词
const v033Pos = {
  'host86-128-12-34.range86-128.btcentralplus.com': 'host（host86-128-12-34）', // BT（英国）
  'host-1-2-3-4.voo.be': 'host（host-1-2-3-4）', // VOO（比利时）
  'host-213-219-136-1.dynamic.voo.be': 'dynamic',
  'dsl-2-1-150-189-dynamic.prod-infinitum.com.mx': 'dsl', // Telmex Infinitum（墨西哥，.com.mx；189.150.1.2 的实际 PTR 格式）
  'dsl-189-203-1-2.dyn.prod-infinitum.mx': 'dsl',
  'host81-155-10-20.range81-155.btcentralplus.com': 'host（host81-155-10-20）', 'host-109-89-10-20.dynamic.voo.be': 'dynamic',
  'customer-187-1-2-3.uninet-ide.com.mx': 'customer',
  'pool-1-2-3-4.example.co.uk': 'pool',
  '85-195-230-77.fiber7.init7.net': 'fiber', '77-57-100-20.dclient.hispeed.ch': 'client（dclient）',
  'adsl-84-226-12-34.adslplus.ch': 'adsl', 'c-73-0-0-1.hsd1.fl.comcast.net': 'hsd',
};
for (const [p, kw] of Object.entries(v033Pos)) {
  const c = classifyPtr(p);
  eq(`v0.3.3 家宽正例 ${p}`, [c.signal, c.keyword], ['residential', kw]);
  eq(`v0.3.3 家宽正例 ${p}：未知 ASN 判家宽`, run(64999, 'Totally Unknown Org', { ptr: { ptr: p, ...c } }).type, 'residential');
}
const v033Neg = {
  'webhost-1.example.net': null, '1-2-3-4.webhost.example.net': null, 'webhost.dsl.example.net': null,
  'cloudprovider-1.example.com': 'datacenter', '1-2-3-4.cloudprovider.com': 'datacenter', 'dsl-1.mycloudnet.example': null,
  'fiberhost-1.example.net': null, 'vpn-pool-1.example.net': null, '1-2-3-4.vpnpool.example': null, 'myproxy-pool.example': null,
  'gke-prod-default-pool-1a2b3c.example.net': 'datacenter', 'mx.dynect.net': null, 'mx1.dsl.example.com.mx': null,
  'host.dsl.example.net': null, 'host.example.com.mx': null, 'mailhost-1-2-3-4.example.net': null, 'host123.example.net': null,
};
// Telmex 另一种实际格式 acceso-<IP>：没有家宽词，但 .mx 不得把它判成服务类（signal 为 null 而不是被屏蔽成别的）
eq('Telmex acceso-187.140.1.2.prod-infinitum.com.mx 不被 .mx 屏蔽', classifyPtr('acceso-187.140.1.2.prod-infinitum.com.mx').blockedBy, undefined);
eq('.mx 只在主机部分才屏蔽', [classifyPtr('dsl-1-2-3-4.prod-infinitum.com.mx').signal, classifyPtr('mx.prod-infinitum.com.mx').blockedBy, classifyPtr('mx.dynect.net').blockedBy], ['residential', 'mx', 'mx']);
eq('粘连词子串屏蔽', ['webhost-1.example.net', 'fiberhost-1.example.net', '1-2-3-4.vpnpool.example', 'host.dsl.example.net'].map((p) => classifyPtr(p).blockedBy), ['host', 'host', 'vpn', 'host']);
eq('vpn-pool 被 vpn 屏蔽', classifyPtr('vpn-pool-1.example.net').blockedBy, 'vpn');
for (const [p, exp] of Object.entries(v033Neg)) {
  const c = classifyPtr(p);
  eq(`v0.3.3 反例 ${p}`, c.signal, exp);
  const r = run(64999, 'Totally Unknown Org', { ptr: { ptr: p, ...c } });
  eq(`v0.3.3 反例 ${p} 不得判家宽`, r.type === 'residential', false);
}
eq('公共后缀拆分', [splitPtrLabels('a.b.prod-infinitum.com.mx'), splitPtrLabels('mx.dynect.net'), splitPtrLabels('x.example.co.uk'), splitPtrLabels('localhost')],
  [{ host: ['a', 'b'], reg: 'prod-infinitum', suffix: ['com', 'mx'] }, { host: ['mx'], reg: 'dynect', suffix: ['net'] }, { host: ['x'], reg: 'example', suffix: ['co', 'uk'] }, { host: [], reg: 'localhost', suffix: [] }]);
// v0.3.4：host + 编号前有机房暗示词时不放行；cloud 子串遇到明确家宽词只取消家宽、不判机房
const v034 = {
  'dedi-host-1-2-3-4.example.com': [null, 'host（dedi）'], 'dedibox-host-1-2-3-4.example.com': [null, 'host（dedi）'],
  'host-1-2-3-4.dc2.example.com': [null, 'host（dc）'], 'rack7-host-1-2-3-4.example.net': [null, 'host（rack）'],
  'dedicated-host-1-2-3-4.example.com': ['datacenter', undefined], 'vps-host-1-2-3-4.example.com': ['datacenter', undefined],
  'server-host-1-2-3-4.example.com': ['datacenter', undefined], 'srv-host-1-2-3-4.example.com': ['datacenter', undefined],
  'colo-host-1-2-3-4.example.com': ['datacenter', undefined], 'cloud-host-1-2-3-4.example.com': ['datacenter', undefined],
  'hosting-host-1-2-3-4.example.com': ['datacenter', undefined],
  'dsl.mcloud.ru': [null, 'cloud'], 'dsl-1-2-3-4.mcloud.ru': [null, 'cloud'], 'pppoe-1.cloudnet.example': [null, 'cloud'],
  'cloudprovider-1.example.com': ['datacenter', undefined], '1-2-3-4.mcloud.ru': ['datacenter', undefined],
  'dsl.webhosting.example': ['datacenter', undefined], 'dynamic-1-2-3-4.cloud.example': ['datacenter', undefined],
};
for (const [p, [sig, by]] of Object.entries(v034)) {
  const c = classifyPtr(p);
  eq(`v0.3.4 ${p}`, [c.signal, c.blockedBy], [sig, by]);
  const r = run(64999, 'Totally Unknown Org', { ptr: { ptr: p, ...c } });
  eq(`v0.3.4 ${p}：未知 ASN 不判家宽`, r.type === 'residential', false);
}
// 机房暗示词不影响正常的 host + 编号家宽
for (const p of ['host86-128-12-34.range86-128.btcentralplus.com', 'host-1-2-3-4.voo.be', 'host-109-89-10-20.dynamic.voo.be']) eq(`v0.3.4 仍为家宽 ${p}`, classifyPtr(p).signal, 'residential');
// 外部数据（ipapi.is）标记机房 + 家宽 PTR：类型为数据中心，PTR 不加分
{
  const p = '85-195-230-77.fiber7.init7.net';
  const r = run(64999, 'Totally Unknown Org', { ptr: { ptr: p, ...classifyPtr(p) }, external: [{ ok: true, source: 'ipapi.is', datacenter: true }] });
  const ps = r.signals.find((x) => x.key === 'ptr');
  eq('ipapi.is 机房 + 家宽 PTR：数据中心、PTR 不加分', [r.type, r.score < 95, ps.effect], ['datacenter', true, 0]);
}

console.log(`${fails ? '✘' : '✔'} 规则测试 ${n} 项，失败 ${fails} 项`);
process.exit(fails ? 1 : 0);
