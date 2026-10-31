// 规则引擎：综合各项信号给出网络类型、纯净度评分（0–100）与风险等级。
// 所有扣分 / 加分均返回明细，便于前端解释“为什么”。纯属基于公开数据的规则推断，仅供参考。

export const TYPE = {
  residential: '家庭宽带', mobile: '移动网络', business: '商业宽带', edu: '教育网', datacenter: '数据中心', proxy: '代理 / Tor', unknown: '未知',
};

const CLS_TEXT = { isp: '固网运营商', mobile: '移动运营商', business: '骨干网 / 企业专线', edu: '教育科研网', hosting: '数据中心 / 云服务', vpn: 'VPN / 代理托管' };

export function analyze({ cloud = [], asn = {}, asnInfo = {}, ptr = {}, tor = {}, external = [], proxyHeaders = [] }) {
  const signals = [];
  const add = (key, name, effect, level, detail) => signals.push({ key, name, effect, level, detail });
  const labels = new Set();

  // 1. 云厂商公开 IP 段
  const hostingAsn = asnInfo.cls === 'hosting' || asnInfo.cls === 'vpn';
  if (cloud.length) {
    // 与机房 ASN 同时命中时只作为“进一步确认”，避免重复重扣
    add('cloud_range', '云厂商 IP 段', hostingAsn ? -20 : -40, 'bad', `命中 ${cloud.map((c) => c.name).join('、')} 官方公布的 IP 段，基本可以确定是云服务器或云服务出口。`);
    labels.add('云服务器');
  } else {
    add('cloud_range', '云厂商 IP 段', 0, 'good', '未命中已收录的云厂商公开 IP 段（AWS、GCP、Azure、Oracle、Cloudflare 等）。');
  }

  // 2. ASN / AS 组织
  const via = asnInfo.by === 'asn' ? `AS${asn.asn} 在内置 ASN 名单中` : asnInfo.by === 'keyword' ? `组织名包含关键词「${asnInfo.keyword}」` : '';
  switch (asnInfo.cls) {
    case 'hosting':
      add('asn', 'ASN 类型', asnInfo.by === 'asn' ? -55 : -45, 'bad', `${via}，属于${CLS_TEXT.hosting}（${asnInfo.name || asn.org || ''}）。`); labels.add('机房 IP'); break;
    case 'vpn':
      add('asn', 'ASN 类型', -60, 'bad', `${via}，该网络常被 VPN / 代理服务商使用（${asnInfo.name || asn.org || ''}）。`); labels.add('疑似 VPN'); labels.add('机房 IP'); break;
    case 'business':
      add('asn', 'ASN 类型', -10, 'warn', `${via}，属于${CLS_TEXT.business}（${asnInfo.name || asn.org || ''}），常见于企业专线、精品线路或中转。`); labels.add('企业网络'); break;
    case 'isp':
      add('asn', 'ASN 类型', 0, 'good', `${via}，属于${CLS_TEXT.isp}（${asnInfo.name || asn.org || ''}）。${asnInfo.note ? asnInfo.note : ''}`); labels.add('运营商网络'); break;
    case 'mobile':
      add('asn', 'ASN 类型', 0, 'good', `${via}，属于${CLS_TEXT.mobile}（${asnInfo.name || asn.org || ''}），移动网络通常多人共享出口 IP。`); labels.add('移动网络'); break;
    case 'edu':
      add('asn', 'ASN 类型', 0, 'good', `${via}，属于${CLS_TEXT.edu}（${asnInfo.name || asn.org || ''}）。`); labels.add('教育网'); break;
    default:
      add('asn', 'ASN 类型', -10, 'warn', asn.asn ? `AS${asn.asn}（${asn.org || '未知组织'}）不在内置名单中，组织名也无法判断类型。` : '未能获取 ASN 信息。');
  }

  // 3. 反向解析
  if (ptr.ptr) {
    if (ptr.signal === 'datacenter') add('ptr', '反向解析 (PTR)', -10, 'bad', `PTR 为 ${ptr.ptr}，包含服务器类关键词「${ptr.keyword}」。`);
    else if (ptr.signal === 'static') add('ptr', '反向解析 (PTR)', -5, 'warn', `PTR 为 ${ptr.ptr}，包含「${ptr.keyword}」，通常是静态 / 商业线路。`);
    else if (ptr.signal === 'residential') add('ptr', '反向解析 (PTR)', 5, 'good', `PTR 为 ${ptr.ptr}，包含宽带用户类关键词「${ptr.keyword}」。`);
    else add('ptr', '反向解析 (PTR)', 0, 'info', `PTR 为 ${ptr.ptr}，未包含可判断类型的关键词。`);
  } else {
    add('ptr', '反向解析 (PTR)', 0, 'info', ptr.error ? '反向解析查询失败。' : '没有 PTR 记录（国内运营商与许多服务器都很常见，不作扣分）。');
  }

  // 4. Tor
  if (tor.tor) { add('tor', 'Tor 出口节点', -50, 'bad', '该 IP 出现在 Tor Project 公布的出口节点列表中。'); labels.add('Tor 出口'); }
  else add('tor', 'Tor 出口节点', 0, 'good', `不在 Tor 出口节点列表中（${tor.source === 'live' ? '在线列表' : '内置列表'}，共 ${tor.count ?? '?'} 个）。`);

  // 5. 代理请求头（仅检测访问者自身时）
  if (proxyHeaders.length) {
    add('proxy_headers', '代理请求头', -15, 'warn', `请求中带有 ${proxyHeaders.join('、')}，说明经过了 HTTP 代理或中间转发。`);
    labels.add('HTTP 代理');
  }

  // 6. 可选的外部风险接口
  for (const x of external) {
    if (!x.ok) { add(`ext_${x.source}`, `外部数据 ${x.source}`, 0, 'info', '查询失败或超时，已忽略。'); continue; }
    if (x.source === 'ipapi.is') {
      let eff = 0; const hits = [];
      if (x.vpn) { eff -= 20; hits.push('VPN'); labels.add('疑似 VPN'); }
      if (x.proxy) { eff -= 20; hits.push('代理'); labels.add('代理'); }
      if (x.tor && !tor.tor) { eff -= 30; hits.push('Tor'); labels.add('Tor 出口'); }
      if (x.datacenter && !cloud.length && asnInfo.cls !== 'hosting') { eff -= 15; hits.push('数据中心'); }
      if (x.abuser) { eff -= 15; hits.push('滥用记录'); labels.add('有滥用记录'); }
      add('ext_ipapi', '外部数据 ipapi.is', eff, eff ? 'bad' : 'good', hits.length ? `标记为：${hits.join('、')}。` : '未标记 VPN / 代理 / 滥用。');
    } else if (x.source === 'proxycheck.io') {
      const eff = (x.proxy ? -20 : 0) - Math.round((x.risk || 0) * 0.2);
      if (x.proxy) labels.add(x.proxyType === 'VPN' ? '疑似 VPN' : '代理');
      add('ext_proxycheck', '外部数据 proxycheck.io', eff, eff ? 'bad' : 'good', `${x.proxy ? `识别为 ${x.proxyType || '代理'}` : '未识别为代理'}，风险值 ${x.risk ?? 0}/100。`);
    } else if (x.source === 'abuseipdb') {
      const eff = -Math.round((x.abuseScore || 0) * 0.4);
      if (x.abuseScore >= 25) labels.add('有滥用记录');
      add('ext_abuseipdb', '外部数据 AbuseIPDB', eff, eff ? 'bad' : 'good', `滥用置信度 ${x.abuseScore}%，近 90 天被举报 ${x.reports ?? 0} 次${x.usageType ? `，用途：${x.usageType}` : ''}。`);
    }
  }

  // ---- 类型判断 ----
  let type = 'unknown', confidence = 'low';
  const extDc = external.some((x) => x.ok && x.datacenter);
  if (cloud.length || asnInfo.cls === 'hosting' || asnInfo.cls === 'vpn') { type = 'datacenter'; confidence = cloud.length || asnInfo.by === 'asn' ? 'high' : 'medium'; }
  else if (asnInfo.cls === 'mobile') { type = 'mobile'; confidence = asnInfo.by === 'asn' ? 'high' : 'medium'; }
  else if (asnInfo.cls === 'edu') { type = 'edu'; confidence = asnInfo.by === 'asn' ? 'high' : 'medium'; }
  else if (asnInfo.cls === 'business') { type = 'business'; confidence = 'medium'; }
  else if (asnInfo.cls === 'isp') {
    if (ptr.signal === 'datacenter' || extDc) { type = 'business'; confidence = 'low'; }
    else if (ptr.signal === 'static') { type = 'business'; confidence = 'medium'; }
    else { type = 'residential'; confidence = asnInfo.by === 'asn' || ptr.signal === 'residential' ? 'high' : 'medium'; }
  } else if (ptr.signal === 'datacenter' || extDc) { type = 'datacenter'; confidence = 'low'; }
  else if (ptr.signal === 'residential') { type = 'residential'; confidence = 'low'; }
  if (tor.tor && type !== 'datacenter') { type = 'proxy'; confidence = 'high'; }
  if (type === 'residential') labels.add('家庭宽带');

  // ---- 评分 ----
  let score = 100 + signals.reduce((s, x) => s + x.effect, 0);
  score = Math.max(0, Math.min(100, score));
  let risk = score >= 80 ? 'low' : score >= 50 ? 'medium' : 'high';
  if (tor.tor) risk = 'high';

  return {
    type, typeText: TYPE[type], confidence, confidenceText: { high: '高', medium: '中', low: '低' }[confidence],
    score, risk, riskText: { low: '低', medium: '中', high: '高' }[risk],
    labels: [...labels], signals,
    note: '评分基于公开 IP 段、ASN 名单、反向解析与 Tor 列表等规则推断，仅供参考，不代表任何平台的真实风控结果。',
  };
}
