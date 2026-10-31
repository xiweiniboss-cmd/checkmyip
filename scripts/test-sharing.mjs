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
// v0.3.1：未收录 ASN + 家宽类 PTR → 按家宽估算（置信度低），不再「无法估算」
const init7 = est({ ip: '85.195.230.77', asn: 13030, org: 'Init7 (Switzerland) Ltd.', cc: 'CH', ptr: '85-195-230-77.fiber7.init7.net' });
eq('Init7 + fiber7 PTR（含 IP 编号）', [classifyAsn(13030, 'Init7 (Switzerland) Ltd.').cls, init7.kind, init7.headline, init7.confidenceText, init7.reasons[0].includes('不在内置库中')], [null, 'household', '约 1–5 人', '低', true]);
const sunrise = est({ ip: '77.57.100.20', asn: 6730, org: 'Sunrise GmbH', cc: 'CH', ptr: '77-57-100-20.dclient.hispeed.ch' });
eq('Sunrise + dclient PTR', [sunrise.kind, sunrise.confidenceText], ['household', '低']);
const adsl = est({ ip: '84.226.12.34', asn: 6730, org: 'Sunrise GmbH', cc: 'CH', ptr: 'adsl-84-226-12-34.adslplus.ch' });
eq('Sunrise + adsl PTR', [adsl.kind, adsl.headline], ['household', '约 1–5 人']);
const dynNoIp = est({ ip: '198.51.100.7', asn: 64999, org: 'Totally Unknown Org', cc: 'DE', ptr: 'dyn-pool.example.de' });
eq('未知 ASN + 不含 IP 的家宽 PTR', [dynNoIp.kind, dynNoIp.confidenceText], ['household', '低']);
const unk6 = est({ ip: '2001:db8:1:2::5', asn: 64999, org: 'Totally Unknown Org', cc: 'DE', ptr: 'ftth-customer.example.de' });
eq('未知 ASN + 家宽 PTR（IPv6）置信度降为低', [unk6.kind, unk6.confidenceText], ['household', '低']);
const unkCn = est({ ip: '203.0.113.20', asn: 64999, org: 'Totally Unknown Org', cc: 'CN', ptr: 'ppp-203-0-113-20.example.cn' });
eq('未知 ASN + 家宽 PTR（中国）按国内宽带', unkCn.kind, 'cn_broadband');
// 没有 PTR 或 PTR 无关键词的未知 ASN 仍然不估算；服务器类 PTR 也不估算（与之前一致）
eq('未知 ASN + 无关键词 PTR', est({ ip: '203.0.113.9', asn: 64999, org: 'Totally Unknown Org', cc: 'US', ptr: 'host-203-0-113-9.example.net' }).kind, 'unknown');
eq('未知 ASN + 服务器 PTR', est({ ip: '203.0.113.9', asn: 64999, org: 'Totally Unknown Org', cc: 'US', ptr: 'vps9.example.net' }).kind, 'unknown');
// Quad9 仍是服务器
eq('Quad9 9.9.9.9', est({ ip: '9.9.9.9', asn: 19281, org: 'QUAD9-AS-1', cc: 'CH', ptr: 'dns9.quad9.net' }).kind, 'server');
eq('IPv6 家宽', est({ ip: '2601:1:2::3', asn: 7922, org: 'Comcast', cc: 'US' }).kind, 'household');
// 每个结果都必须带“估算”说明和原因
for (const r of [cm, ct, cc, aws, tor]) eq(`${r.kind} 有说明`, [!!r.note && r.note.includes('估算'), r.reasons.length > 0], [true, true]);
// PTR 编号匹配
eq('PTR 正序', ptrEmbedsIp('c-73-0-0-1.hsd1.fl.comcast.net', '73.0.0.1'), true);
eq('PTR 倒序', ptrEmbedsIp('1.1.222.114.broad.nj.js.dynamic.163data.com.cn', '114.222.1.1'), true);
eq('PTR 不含编号', ptrEmbedsIp('cpe.example.net', '73.0.0.1'), false);
eq('PTR 其他 IP', ptrEmbedsIp('c-73-0-0-2.hsd1.fl.comcast.net', '73.0.0.1'), false);

// v0.3.2：外部数据（ipapi.is）说是机房时，不按家宽估算人数
const ipapiDc = [{ ok: true, source: 'ipapi.is', datacenter: true, vpn: false, proxy: false, tor: false }];
const xDc = est({ ip: '85.195.230.77', asn: 13030, org: 'Init7 (Switzerland) Ltd.', cc: 'CH', ptr: '85-195-230-77.fiber7.init7.net', external: ipapiDc });
eq('未知 ASN + 家宽 PTR + ipapi.is 机房 → 服务器，不是 1–5 人', [xDc.kind, xDc.headline, xDc.reasons[0].includes('ipapi.is') && xDc.reasons[0].includes('矛盾')], ['server', '未知', true]);
const xDc0 = est({ ip: '85.195.230.77', asn: 13030, org: 'Init7 (Switzerland) Ltd.', cc: 'CH', ptr: '85-195-230-77.fiber7.init7.net', external: [{ ok: true, source: 'ipapi.is', datacenter: false }] });
eq('同上但 ipapi.is 未标记机房 → 仍为单户家庭', [xDc0.kind, xDc0.headline], ['household', '约 1–5 人']);
const xDcIsp = est({ ip: '73.0.0.1', asn: 7922, org: 'Comcast Cable Communications', cc: 'US', ptr: 'c-73-0-0-1.hsd1.fl.comcast.net', external: ipapiDc });
eq('已知家宽 ASN + ipapi.is 机房 → 无法估算（信号矛盾）', [xDcIsp.kind, xDcIsp.headline, xDcIsp.scene], ['unknown', '无法估算', '外部数据标记为机房']);
const xDcFail = est({ ip: '73.0.0.1', asn: 7922, org: 'Comcast Cable Communications', cc: 'US', ptr: 'c-73-0-0-1.hsd1.fl.comcast.net', external: [{ ok: false, source: 'ipapi.is', datacenter: true }] });
eq('ipapi.is 请求失败（ok=false）不影响', xDcFail.kind, 'household');
const xDcMob = est({ ip: '117.136.0.1', asn: 9808, org: 'China Mobile', cc: 'CN', external: ipapiDc });
eq('移动网络不受外部机房标记影响（仍为运营商级 NAT）', xDcMob.kind, 'cgnat_mobile');

console.log(`${fails ? '✘' : '✔'} 人数估算测试 ${n} 项，失败 ${fails} 项`);
process.exit(fails ? 1 : 0);
