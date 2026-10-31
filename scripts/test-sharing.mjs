#!/usr/bin/env node
// 「预估多少人在用这个 IP」启发式测试：输入尽量与 worker 中 lookup() 传入的结构一致
import { classifyAsn, classifyPtr } from '../src/lib/asn.js';
import { analyze } from '../src/lib/score.js';
import { estimateSharing, ptrEmbedsIp } from '../src/lib/sharing.js';
let fails = 0, n = 0;
const eq = (name, got, exp) => { n++; if (JSON.stringify(got) !== JSON.stringify(exp)) { fails++; console.error(`✘ ${name}: 期望 ${JSON.stringify(exp)} 实际 ${JSON.stringify(got)}`); } };

function est({ ip, asn, org, cc, ptr = null, cloud = [], tor = false, external = [] }) {
  const version = ip.includes(':') ? 6 : 4;
  const asnInfo = classifyAsn(asn, org);
  const ptrInfo = ptr ? { ptr, ...classifyPtr(ptr) } : {};
  const t = { tor, source: 'bundled', count: 1 };
  const analysis = analyze({ cloud, asn: { asn, org }, asnInfo, ptr: ptrInfo, tor: t, external, quality: { geoOk: true, ptrOk: true } });
  return estimateSharing({ ip, version, countryCode: cc, asnInfo, ptr: ptrInfo, cloud, tor: t, external, analysis });
}

// 中国移动（手机 / 移动家宽）→ 运营商级 NAT
const cm = est({ ip: '117.136.0.1', asn: 9808, org: 'China Mobile Communications Group Co., Ltd.', cc: 'CN' });
eq('中国移动 117.136.0.1', [cm.kind, cm.label, cm.confidenceText], ['cgnat_mobile', '约 10–100+ 人（运营商级 NAT）', '中']);
// 海外移动运营商
const tm = est({ ip: '172.56.0.1', asn: 21928, org: 'T-Mobile USA', cc: 'US' });
eq('T-Mobile', [tm.kind, tm.headline], ['cgnat_mobile', '约 10–100+ 人']);
// 中国电信家宽（无 PTR / 有批量生成的 PTR）→ 可能共享
const ct = est({ ip: '114.222.1.1', asn: 4134, org: 'CHINANET-BACKBONE', cc: 'CN' });
eq('中国电信家宽 114.222.1.1', [ct.kind, ct.label, ct.confidenceText], ['cn_broadband', '约 1–数十人（可能共享出口）', '低']);
const ct2 = est({ ip: '114.222.1.1', asn: 4134, org: 'CHINANET-BACKBONE', cc: 'CN', ptr: '1.1.222.114.broad.nj.js.dynamic.163data.com.cn' });
eq('中国电信家宽 + 批量 PTR 仍是可能共享', [ct2.kind, ct2.reasons.some((r) => r.includes('批量生成'))], ['cn_broadband', true]);
// Comcast + 按用户分配的 PTR → 单户家庭
const cc = est({ ip: '73.0.0.1', asn: 7922, org: 'Comcast Cable Communications', cc: 'US', ptr: 'c-73-0-0-1.hsd1.fl.comcast.net' });
eq('Comcast 73.0.0.1 + PTR', [cc.kind, cc.label, cc.confidenceText, cc.range], ['household', '约 1–5 人（单户家庭）', '中', { min: 1, max: 5 }]);
const ccNoPtr = est({ ip: '73.0.0.1', asn: 7922, org: 'Comcast', cc: 'US' });
eq('Comcast 无 PTR → 家庭或小型网络（低）', [ccNoPtr.kind, ccNoPtr.confidenceText], ['residential', '低']);
// AWS → 服务器，未知
const aws = est({ ip: '3.5.140.1', asn: 16509, org: 'AMAZON-02', cc: 'US', cloud: [{ provider: 'aws', name: 'Amazon AWS' }] });
eq('AWS', [aws.kind, aws.headline, aws.confidenceText], ['server', '未知', '低']);
// Tor 出口 → 可能数百人
const tor = est({ ip: '185.220.101.1', asn: 60729, org: 'Stiftung Erneuerbare Freiheit', cc: 'DE', tor: true });
eq('Tor 出口', [tor.kind, tor.label], ['public_proxy', '可能数百人（公共出口 / Tor）']);
// 已知 VPN ASN / 外部标记代理
const vpn = est({ ip: '89.187.160.1', asn: 60068, org: 'Datacamp Limited', cc: 'GB' });
eq('VPN 托管 ASN', [classifyAsn(60068).cls, vpn.kind], ['vpn', 'public_proxy']);
const extp = est({ ip: '24.1.1.1', asn: 7922, org: 'Comcast', cc: 'US', external: [{ ok: true, source: 'x', proxy: true }] });
eq('外部标记代理', extp.kind, 'public_proxy');
// 教育网 / 企业 / 未知 / IPv6 家宽
eq('CERNET', est({ ip: '166.111.1.1', asn: 4538, org: 'CERNET', cc: 'CN' }).kind, 'nat_large');
eq('transit', est({ ip: '184.105.1.1', asn: 6939, org: 'Hurricane Electric', cc: 'US' }).kind, 'nat_org');
eq('未知 ASN', est({ ip: '203.0.113.9', asn: 64999, org: 'Totally Unknown Org', cc: 'US' }).kind, 'unknown');
eq('IPv6 家宽', est({ ip: '2601:1:2::3', asn: 7922, org: 'Comcast', cc: 'US' }).kind, 'household');
// 每个结果都必须带“估算”说明和原因
for (const r of [cm, ct, cc, aws, tor]) eq(`${r.kind} 有说明`, [!!r.note && r.note.includes('估算'), r.reasons.length > 0], [true, true]);
// PTR 编号匹配
eq('PTR 正序', ptrEmbedsIp('c-73-0-0-1.hsd1.fl.comcast.net', '73.0.0.1'), true);
eq('PTR 倒序', ptrEmbedsIp('1.1.222.114.broad.nj.js.dynamic.163data.com.cn', '114.222.1.1'), true);
eq('PTR 不含编号', ptrEmbedsIp('cpe.example.net', '73.0.0.1'), false);
eq('PTR 其他 IP', ptrEmbedsIp('c-73-0-0-2.hsd1.fl.comcast.net', '73.0.0.1'), false);

console.log(`${fails ? '✘' : '✔'} 人数估算测试 ${n} 项，失败 ${fails} 项`);
process.exit(fails ? 1 : 0);
