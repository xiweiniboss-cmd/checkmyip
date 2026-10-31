// 「预估多少人在用这个 IP」——按 IP 类型的启发式估算（不是实际统计）。
// 依据：网络类型（移动 / 家宽 / 教育网 / 企业 / 机房）、PTR 是否按用户分配、Tor / VPN 标记等。
// 前端还会补充两条客户端证据（WebRTC 发现 100.64.0.0/10 地址、IPv4 探测与 WebRTC 公网 IP 不一致）。

export const SHARING_NOTE = '这是根据 IP 类型推测的估算，不是实际统计；运营商是否使用 NAT 共享、共享多少人，外部无法准确得知。';

const CONF_TEXT = { high: '高', medium: '中', low: '低' };

/** PTR 中是否按顺序（或倒序）包含该 IPv4 的四段数字，如 c-73-0-0-1.hsd1.fl.comcast.net */
export function ptrEmbedsIp(ptr, ip) {
  if (!ptr || !ip || ip.includes(':')) return false;
  const oct = ip.split('.');
  const nums = String(ptr).split(/[^0-9]+/).filter(Boolean).map((x) => String(Number(x)));
  const has = (seq) => {
    for (let i = 0; i + 4 <= nums.length; i++) if (seq.every((v, k) => nums[i + k] === v)) return true;
    return false;
  };
  return has(oct) || has([...oct].reverse());
}

function out(kind, headline, scene, min, max, confidence, reasons) {
  return { kind, label: scene ? `${headline}（${scene}）` : headline, headline, scene, range: { min, max }, confidence, confidenceText: CONF_TEXT[confidence], reasons, note: SHARING_NOTE };
}

/**
 * @param o { ip, version, countryCode, asnInfo, ptr: {ptr, signal}, cloud, tor, external, analysis }
 */
export function estimateSharing({ ip, version, countryCode, asnInfo = {}, ptr = {}, cloud = [], tor = {}, external = [], analysis = {} }) {
  const ext = external.filter((x) => x.ok);
  const extProxy = ext.some((x) => x.vpn || x.proxy || x.tor);
  const name = asnInfo.name || '';

  if (tor.tor) return out('public_proxy', '可能数百人', '公共出口 / Tor', 100, null, 'medium',
    ['该 IP 是 Tor 出口节点，全球的 Tor 用户都可能从这里出去，同一时间可能有大量用户共用。']);
  if (asnInfo.cls === 'vpn' || extProxy) return out('public_proxy', '可能数百人', '公共出口 / 代理', 50, null, asnInfo.cls === 'vpn' && asnInfo.by === 'asn' ? 'medium' : 'low',
    [asnInfo.cls === 'vpn' ? `所属网络（${name || '未知'}）常被 VPN / 代理服务商用作出口，一个出口 IP 往往同时服务很多用户。` : '外部数据把该 IP 标记为 VPN / 代理，代理出口通常多人共用。']);
  if (cloud.length || asnInfo.cls === 'hosting') return out('server', '未知', '服务器 IP，若用作代理出口则可能多人', 1, null, 'low',
    ['这是云服务器 / 机房 IP：如果只是网站或服务，背后可能没有“人”；如果被用作 VPN / 代理出口，则可能多人共用，外部无法区分。']);
  if (analysis.incomplete || !asnInfo.cls) return out('unknown', '无法估算', analysis.incomplete ? '数据不完整' : '网络类型未知', null, null, 'low',
    [analysis.incomplete ? '没有拿到 ASN，无法判断网络类型，因此不做估算。' : '该 ASN 不在内置库中，名称也无法判断类型，因此不做估算。']);

  if (asnInfo.cls === 'mobile') return out('cgnat_mobile', '约 10–100+ 人', '运营商级 NAT', 10, null, asnInfo.by === 'asn' ? 'medium' : 'low',
    [`属于移动运营商（${name || '移动网络'}）。手机网络几乎都使用运营商级 NAT（CGNAT），同一个公网 IPv4 通常同时被几十到上百台设备共用。`]);
  // 中国移动：家宽与 4G/5G 混用同一 ASN，二者都普遍使用 CGNAT
  if (asnInfo.cls === 'isp' && /中国移动|china mobile|cmnet/i.test(name) && !/国际|international/i.test(name) && version === 4) return out('cgnat_mobile', '约 10–100+ 人', '运营商级 NAT', 10, null, asnInfo.by === 'asn' ? 'medium' : 'low',
    ['属于中国移动：其 4G/5G 网络与大部分移动家宽都通过运营商级 NAT（CGNAT）上网，同一公网 IPv4 通常被很多用户共用。', '仅凭 ASN 无法区分手机网络与家宽，所以范围较宽。']);
  if (asnInfo.cls === 'edu') return out('nat_large', '可能数百人', '校园网 / 机构 NAT', 50, null, 'medium',
    ['属于教育科研网：校园网通常让整栋楼甚至整个学校通过少量出口 IP 上网。']);
  if (asnInfo.cls === 'business' || asnInfo.cls === 'transit' || ptr.signal === 'static' || ptr.signal === 'datacenter') return out('nat_org', '约 1–数百人', '企业 / 机构出口，规模未知', 1, null, 'low',
    ['属于企业专线 / 商业网络：可能是一家公司整体的 NAT 出口（几十到上百人），也可能只是一台服务器或一个小办公室，外部无法判断规模。']);

  if (asnInfo.cls === 'isp') {
    const embeds = ptrEmbedsIp(ptr.ptr, ip);
    const cn = countryCode === 'CN';
    if (version === 6) return out('household', '约 1–5 人', '单户家庭', 1, 5, 'medium',
      ['这是家庭宽带的 IPv6 地址。运营商通常给每户分配独立的 IPv6 前缀，一个 IPv6 地址一般只对应一户甚至一台设备。']);
    if (cn) return out('cn_broadband', '约 1–数十人', '可能共享出口', 1, 50, 'low',
      ['国内固网宽带的公网 IPv4 紧张，不少地区使用运营商级 NAT（CGNAT）让多户共用一个公网 IP，也有不少用户仍能拿到独享公网 IP，外部无法区分。',
        ...(embeds ? [`反向解析 ${ptr.ptr} 虽然包含 IP 编号，但国内运营商通常为整个地址池批量生成反解，不能说明这个 IP 是一户独享。`] : []),
        '若你家路由器的 WAN 口地址是 100.64.x.x–100.127.x.x，就说明处在运营商 NAT 后面。']);
    if (embeds && ptr.signal === 'residential') return out('household', '约 1–5 人', '单户家庭', 1, 5, 'medium',
      [`反向解析 ${ptr.ptr} 包含该 IP 的编号和宽带用户类关键词，说明运营商按用户逐个分配公网 IP，通常一个家庭一个 IP（家里的手机、电脑共用）。`]);
    if (ptr.signal === 'residential') return out('household', '约 1–5 人', '单户家庭', 1, 5, 'low',
      [`反向解析 ${ptr.ptr} 带有宽带用户类关键词，多半是分配给单个家庭的地址。`]);
    return out('residential', '约 1–10 人', '家庭或小型网络', 1, 10, 'low',
      ['属于固网宽带运营商，多数情况下一个公网 IP 对应一个家庭或小型办公室，但也可能使用运营商级 NAT。']);
  }
  return out('unknown', '无法估算', '网络类型未知', null, null, 'low', ['无法判断网络类型，因此不做估算。']);
}
