// 基于 ASN 编号与 AS 组织名称关键词的网络类型判断（人工整理，仅作参考）
// class: isp(家庭/固网宽带) | mobile(移动网络) | business(商业/企业/骨干) | edu(教育科研) | hosting(数据中心/云) | vpn(已知 VPN/代理托管)

const L = (cls, pairs) => pairs.map(([asn, name]) => [asn, { cls, name }]);

const ASN_TABLE = new Map([
  // 中国移动：同一 ASN 同时承载家庭宽带与 4G/5G，仅凭 ASN 无法区分
  ...[[9808, '中国移动 CMNET'], [56040, '中国移动 广东'], [56041, '中国移动 浙江'], [56042, '中国移动 山西'],
    [56044, '中国移动'], [56046, '中国移动 江苏'], [56047, '中国移动 湖南'], [56048, '中国移动 北京'],
    [24400, '中国移动 上海'], [24444, '中国移动 山东'], [24445, '中国移动 河南']]
    .map(([asn, name]) => [asn, { cls: 'isp', name, note: '中国移动同一 ASN 同时承载家庭宽带与 4G/5G 网络，仅凭 ASN 无法区分二者。' }]),
  // ---------- 中国大陆 · 运营商 ----------
  ...L('isp', [
    [4134, '中国电信 CHINANET'], [4812, '中国电信 上海'], [4811, '中国电信 上海'], [4816, '中国电信 广东'],
    [4837, '中国联通 China169'], [4808, '中国联通 北京'], [17816, '中国联通 广东'], [17621, '中国联通 上海'],
    [17622, '中国联通 广州'], [17623, '中国联通 深圳'],
    [9394, '中国铁通'], [17964, '鹏博士 / 长城宽带'], [4609, '澳门电讯 CTM'],
  ]),
  ...L('business', [
    [4809, '中国电信 CN2'], [9929, '中国联通 工业互联网 (A网)'], [10099, '中国联通国际 CUG'],
    [58453, '中国移动国际 CMI'], [4847, '中国电信 (骨干)'],
  ]),
  ...L('edu', [
    [4538, '中国教育和科研计算机网 CERNET'], [23910, 'CERNET2'], [24348, 'CERNET'], [7497, '中国科技网 CSTNET'],
  ]),
  // ---------- 中国大陆 · 云 / IDC ----------
  ...L('hosting', [
    [37963, '阿里云'], [45102, '阿里云 (国际)'], [24429, '阿里巴巴'], [134963, '阿里云 (国际)'],
    [45090, '腾讯云'], [132203, '腾讯云 (国际)'], [136907, '华为云'], [55990, '华为云'],
    [38365, '百度'], [55967, '百度'], [137718, '火山引擎'], [396986, '字节跳动'],
    [59019, '金山云'], [135377, 'UCloud'], [23724, '中国电信 IDC'], [58466, '中国电信 广州 IDC'],
    [38283, '中国电信 四川 IDC'],
  ]),
  // ---------- 海外 · 云 / 主机 / CDN ----------
  ...L('hosting', [
    [16509, 'Amazon AWS'], [14618, 'Amazon AWS'], [8987, 'Amazon AWS'], [15169, 'Google'], [396982, 'Google Cloud'],
    [19527, 'Google'], [36040, 'YouTube (Google)'], [139070, 'Google'], [8075, 'Microsoft Azure'], [8068, 'Microsoft'],
    [31898, 'Oracle Cloud'], [7160, 'Oracle'], [36351, 'IBM Cloud / SoftLayer'], [14061, 'DigitalOcean'],
    [20473, 'Vultr / Choopa'], [63949, 'Linode / Akamai'], [20940, 'Akamai'], [16625, 'Akamai'], [16276, 'OVHcloud'],
    [24940, 'Hetzner'], [213230, 'Hetzner Cloud'], [212317, 'Hetzner'], [13335, 'Cloudflare'], [209242, 'Cloudflare'],
    [54113, 'Fastly'], [60781, 'Leaseweb'], [28753, 'Leaseweb'], [16265, 'Leaseweb'], [30633, 'Leaseweb'],
    [59253, 'Leaseweb Asia'], [395954, 'Leaseweb'], [25820, 'IT7 / 搬瓦工 BandwagonHost'], [51167, 'Contabo'],
    [40021, 'Contabo'], [12876, 'Scaleway'], [197540, 'netcup'], [40676, 'Psychz'], [35916, 'Multacom'],
    [8100, 'QuadraNet'], [36352, 'ColoCrossing'], [26496, 'GoDaddy'], [398101, 'GoDaddy'], [47583, 'Hostinger'],
    [8560, 'IONOS'], [906, 'DMIT'], [21859, 'Zenlayer'], [63473, 'HostHatch'], [53667, 'FranTech / BuyVM'],
    [36007, 'Kamatera'], [200350, 'Yandex Cloud'], [49505, 'Selectel'], [210644, 'Aeza'], [44477, 'Stark Industries'],
    [63023, 'GTHost'], [46844, 'Sharktech'], [54290, 'Hostwinds'], [54825, 'Equinix Metal'], [199524, 'G-Core Labs'],
    [202422, 'G-Core Labs'], [7979, 'Servers.com'], [46475, 'Limestone Networks'], [62240, 'Clouvider'],
    [36236, 'NetActuate'], [32097, 'WholeSale Internet'], [3258, 'xTom'], [62904, 'Eonix'], [19318, 'Interserver'],
    [174, 'Cogent (含大量机房)'],
  ]),
  // ---------- 已知 VPN / 代理托管 ----------
  ...L('vpn', [
    [9009, 'M247 (常见 VPN 出口)'], [60068, 'Datacamp / CDN77 (常见 VPN 出口)'], [207137, 'PacketHub (NordVPN)'],
    [147049, 'PacketHub (NordVPN)'], [136787, 'Tefincom (NordVPN)'], [39351, '31173 Services (Mullvad)'],
    [212238, 'Datacamp (常见 VPN 出口)'],
  ]),
  // ---------- 海外 · 骨干 / 企业 ----------
  ...L('business', [
    [6939, 'Hurricane Electric'], [2914, 'NTT Global IP Network'], [3491, 'PCCW Global'], [1299, 'Arelion (Telia)'],
    [3356, 'Lumen (Level3)'], [6461, 'Zayo'], [3257, 'GTT'], [6453, 'TATA Communications'], [9304, 'HGC 和记环球电讯'],
  ]),
  // ---------- 海外 · 移动运营商 ----------
  ...L('mobile', [
    [21928, 'T-Mobile US'], [6167, 'Verizon Wireless'], [22394, 'Verizon Wireless'], [20057, 'AT&T Mobility'],
    [9605, 'NTT docomo'], [9644, 'SK Telecom'], [55836, 'Reliance Jio'], [45609, 'Bharti Airtel Mobile'],
    [24158, '台湾大哥大'], [9231, '中国移动香港'], [17924, 'SmarTone 数码通'], [45143, 'Singtel Mobile'],
  ]),
  // ---------- 海外 · 固网 ISP ----------
  ...L('isp', [
    [7922, 'Comcast'], [20115, 'Charter Spectrum'], [11427, 'Charter Spectrum'], [20001, 'Charter Spectrum'],
    [10796, 'Charter Spectrum'], [11351, 'Charter Spectrum'], [12271, 'Charter Spectrum'], [33363, 'Charter Spectrum'],
    [7018, 'AT&T'], [701, 'Verizon'], [22773, 'Cox'], [209, 'CenturyLink'], [5650, 'Frontier'], [6128, 'Optimum (Altice)'],
    [812, 'Rogers'], [577, 'Bell Canada'], [6327, 'Shaw'], [852, 'TELUS'],
    [2856, 'BT'], [5089, 'Virgin Media'], [5607, 'Sky Broadband'], [13285, 'TalkTalk'],
    [3320, 'Deutsche Telekom'], [3209, 'Vodafone 德国'], [3215, 'Orange 法国'], [12322, 'Free 法国'],
    [15557, 'SFR'], [5410, 'Bouygues Telecom'], [3352, 'Telefónica 西班牙'], [1136, 'KPN'], [33915, 'Ziggo'],
    [4713, 'NTT OCN'], [2516, 'KDDI'], [17676, 'SoftBank'], [2527, 'So-net'],
    [3462, '中华电信 HiNet'], [9269, '香港宽频 HKBN'], [4760, '香港电讯 HKT / 网上行'], [9908, '有线宽频 i-Cable'],
    [3758, 'Singtel SingNet'], [4657, 'StarHub'], [1221, 'Telstra'], [4804, 'Optus'], [7545, 'TPG'],
    [4766, 'Korea Telecom'], [9318, 'SK Broadband'], [3786, 'LG U+'], [12389, 'Rostelecom'], [8359, 'MTS'],
    [9121, 'Türk Telekom'], [45899, 'VNPT'], [7552, 'Viettel'], [18403, 'FPT Telecom'], [7470, 'True Internet'],
    [45758, '3BB'], [4788, 'TM Net'], [7713, 'Telkom Indonesia'], [9299, 'PLDT'], [9829, 'BSNL'],
    [24560, 'Bharti Airtel'], [28573, 'Claro 巴西'], [18881, 'Vivo 巴西'],
  ]),
]);

const KW = {
  vpn: ['vpn', 'proxy', 'tunnel', 'anonymous', 'private internet access', 'nordvpn', 'expressvpn', 'surfshark',
    'mullvad', 'protonvpn', 'packethub', 'tefincom', 'datacamp', 'm247'],
  hosting: ['hosting', 'host', 'cloud', 'server', 'datacenter', 'data center', 'data-center', 'vps', 'colo',
    'servers', 'clouds', 'datacentre', 'dedicated', 'idc', 'compute', 'amazon', 'aws', 'google', 'microsoft', 'azure', 'oracle', 'digitalocean',
    'vultr', 'choopa', 'linode', 'akamai', 'ovh', 'hetzner', 'leaseweb', 'contabo', 'scaleway', 'alibaba',
    'aliyun', 'tencent', 'huawei', 'baidu', 'ucloud', 'kingsoft', 'cdn', 'cloudflare', 'fastly', 'gcore',
    'g-core', 'zenlayer', 'quadranet', 'psychz', 'colocrossing', 'hostwinds', 'it7', 'bandwagon', 'dmit',
    'kamatera', 'servers.com', 'internet data center', '数据中心', '云'],
  edu: ['university', 'college', 'education', 'cernet', 'academy', 'school', 'research network', 'edu'],
  mobile: ['mobile', 'wireless', 'cellular', 'lte', 'docomo', 'jio', 't-mobile', 'telefonica moviles', 'movil', 'celular'],
  isp: ['telecom', 'telekom', 'broadband', 'cable', 'communications', 'internet service', 'fiber', 'fibre',
    'dsl', 'telecommunication', 'telecommunications', 'telco', 'netvigator', 'hinet', 'comcast', 'charter', 'spectrum', 'verizon',
    'at&t', 'cox', 'unicom', 'chinanet', 'cmnet', 'telefonica', 'vodafone', 'orange', 'kddi', 'softbank', '电信', '联通', '移动', '宽带'],
};

// ASCII 关键词按“整词”匹配（避免 colo 命中 Colombia），中文关键词按子串匹配
const reCache = new Map();
function hasWord(s, k) {
  if (/[^\x00-\x7f]/.test(k)) return s.includes(k);
  let re = reCache.get(k);
  if (!re) { re = new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&')}([^a-z0-9]|$)`); reCache.set(k, re); }
  return re.test(s);
}

/** 根据 ASN 与组织名判断网络类别。返回 { cls, name, by: 'asn'|'keyword'|null, keyword? } */
export function classifyAsn(asn, org) {
  const n = Number(String(asn ?? '').replace(/^AS/i, ''));
  if (n && ASN_TABLE.has(n)) return { ...ASN_TABLE.get(n), by: 'asn' };
  const s = String(org || '').toLowerCase();
  if (s.trim()) {
    for (const cls of ['vpn', 'hosting', 'edu', 'mobile', 'isp']) {
      const kw = KW[cls].find((k) => hasWord(s, k));
      if (kw) return { cls, name: org, by: 'keyword', keyword: kw };
    }
  }
  return { cls: null, name: org || null, by: null };
}

// PTR 反向解析关键词
const PTR_RES = ['dynamic', 'dyn', 'pool', 'dsl', 'adsl', 'vdsl', 'ppp', 'pppoe', 'dhcp', 'cable', 'fiber', 'fibre',
  'ftth', 'home', 'broadband', 'bb', 'cust', 'customer', 'residential', 'user', 'client', 'res', 'cpe', 'wlan', 'mobile', 'hsd', 'broad', 'adsl', 'xdsl', 'catv', 'ip-pool'];
const PTR_STATIC = ['static', 'fixed', 'business', 'biz'];
const PTR_DC = ['server', 'srv', 'vps', 'host', 'hosting', 'cloud', 'colo', 'dedicated', 'ded', 'ec2',
  'compute', 'googleusercontent', 'amazonaws', 'linode', 'vultr', 'hetzner', 'ovh', 'contabo', 'datacenter', 'dc', 'node', 'rack'];

/** PTR 关键词判断：{ signal: 'residential'|'static'|'datacenter'|null, keyword } */
export function classifyPtr(ptr) {
  if (!ptr) return { signal: null };
  const tokens = ptr.toLowerCase().replace(/\.$/, '').split(/[.\-_\d]+/).filter(Boolean);
  const dc = PTR_DC.find((k) => tokens.includes(k) || (k.length > 5 && ptr.toLowerCase().includes(k)));
  if (dc) return { signal: 'datacenter', keyword: dc };
  const st = PTR_STATIC.find((k) => tokens.includes(k));
  if (st) return { signal: 'static', keyword: st };
  const res = PTR_RES.find((k) => tokens.includes(k) || (k.length > 5 && ptr.toLowerCase().includes(k)));
  if (res) return { signal: 'residential', keyword: res };
  return { signal: null };
}
