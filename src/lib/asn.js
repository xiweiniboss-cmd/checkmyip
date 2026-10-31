// 基于 ASN 编号与 AS 组织名称关键词的网络类型判断（人工整理，仅作参考）
// class: isp(家庭/固网宽带) | mobile(移动网络) | business(商业/企业专线) | transit(国际骨干/转接) | edu(教育科研) | hosting(数据中心/云) | vpn(已知 VPN/代理托管)
// mixed: true 表示该 ASN 同时承载家宽与其它用途（移动网络 / 企业专线），判为家宽时置信度只给「中」

const CMCC_NOTE = '中国移动同一 ASN 同时承载家庭宽带与 4G/5G 网络，仅凭 ASN 无法区分二者。';
const L = (cls, pairs) => pairs.map(([asn, name]) => [asn, { cls, name }]);

const ASN_TABLE = new Map([
  // 中国移动：同一 ASN 同时承载家庭宽带与 4G/5G，仅凭 ASN 无法区分
  ...[[9808, '中国移动 CMNET'], [56040, '中国移动 广东'], [56041, '中国移动 浙江'], [56042, '中国移动 山西'],
    [56044, '中国移动'], [56046, '中国移动 江苏'], [56047, '中国移动 湖南'], [56048, '中国移动 北京'],
    [24400, '中国移动 上海'], [24444, '中国移动 山东'], [24445, '中国移动 河南']]
    .map(([asn, name]) => [asn, { cls: 'isp', name, mixed: true, note: CMCC_NOTE }]),
  // ---------- 中国大陆 · 运营商 ----------
  ...L('isp', [
    [4134, '中国电信 CHINANET'], [4812, '中国电信 上海'], [4811, '中国电信 上海'], [4816, '中国电信 广东'],
    [4837, '中国联通 China169'], [4808, '中国联通 北京'], [17816, '中国联通 广东'], [17621, '中国联通 上海'],
    [17622, '中国联通 广州'], [17623, '中国联通 深圳'],
    [9394, '中国铁通'], [17964, '鹏博士 / 长城宽带'], [4609, '澳门电讯 CTM'],
  ]),
  // CN2 属于中国电信运营商网络，但大量用于企业专线与跨境精品线路，判为家宽时置信度只给「中」
  [4809, { cls: 'isp', name: '中国电信 CN2', mixed: true, note: 'CN2 为中国电信精品网，除家宽外也大量用于企业专线与跨境线路。' }],
  ...L('business', [
    [9929, '中国联通 工业互联网 (A网)'], [10099, '中国联通国际 CUG'],
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
    [19281, 'Quad9 (DNS / Anycast)'], [36692, 'Cisco OpenDNS (DNS / Anycast)'], [30607, 'Cisco Umbrella'],
    [202422, 'G-Core Labs'], [7979, 'Servers.com'], [46475, 'Limestone Networks'], [62240, 'Clouvider'],
    [36236, 'NetActuate'], [32097, 'WholeSale Internet'], [3258, 'xTom'], [62904, 'Eonix'], [19318, 'Interserver'],
  ]),
  // ---------- 已知 VPN / 代理托管 ----------
  ...L('vpn', [
    [9009, 'M247 (常见 VPN 出口)'], [60068, 'Datacamp / CDN77 (常见 VPN 出口)'], [207137, 'PacketHub (NordVPN)'],
    [147049, 'PacketHub (NordVPN)'], [136787, 'Tefincom (NordVPN)'], [39351, '31173 Services (Mullvad)'],
    [212238, 'Datacamp (常见 VPN 出口)'],
  ]),
  // ---------- 海外 · 国际骨干 / 转接（transit）----------
  // 这些网络主要卖 IP 转接与企业专线，也直连大量机房客户，但本身不是机房：小幅扣分，归为商业宽带。
  ...[[174, 'Cogent', 'Cogent 直连了大量机房 / 主机商客户，地址常被用作服务器出口。'],
    [6939, 'Hurricane Electric', 'HE 同时提供免费 IPv6 隧道（tunnelbroker），隧道地址常被代理使用。'],
    [3356, 'Lumen (Level3)'], [2914, 'NTT Global IP Network'], [1299, 'Arelion (Telia)'], [3257, 'GTT'],
    [3491, 'PCCW Global'], [6461, 'Zayo'], [6453, 'TATA Communications']]
    .map(([asn, name, note]) => [asn, { cls: 'transit', name, ...(note ? { note } : {}) }]),
  ...L('business', [[9304, 'HGC 和记环球电讯']]),
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
  // 未收录编号的中国移动省网：同样是家宽与移动网络混用
  if (/china mobile|cmnet|中国移动/.test(s) && !/international|国际|hong kong|香港/.test(s)) return { cls: 'isp', name: org, by: 'keyword', keyword: 'china mobile', mixed: true, note: CMCC_NOTE };
  if (s.trim()) {
    for (const cls of ['vpn', 'hosting', 'edu', 'mobile', 'isp']) {
      const kw = KW[cls].find((k) => hasWord(s, k));
      if (kw) return { cls, name: org, by: 'keyword', keyword: kw };
    }
  }
  return { cls: null, name: org || null, by: null };
}

// PTR 反向解析关键词。PTR 按 . - _ 与数字切成词（fiber7 → fiber、hsd1 → hsd），家宽词整词比较（liverpool、dyndns 不算家宽）；
// 拆不开的粘连词（webhost、cloudprovider、vpnpool）再按子串查少数足够独特的服务器 / 服务类片段；国家后缀（.mx 等）不参与。
const PTR_RES = new Set(['dynamic', 'dyn', 'dynip', 'pool', 'dsl', 'adsl', 'vdsl', 'xdsl', 'sdsl', 'ppp', 'pppoe', 'dhcp', 'cable',
  'kabel', 'fiber', 'fibre', 'ftth', 'fttx', 'fttp', 'fttb', 'fttc', 'home', 'broadband', 'broad', 'bb', 'cust', 'customer',
  'customers', 'residential', 'res', 'user', 'users', 'client', 'clients', 'subscriber', 'cpe', 'wlan', 'mobile',
  'hsd', 'hsi', 'catv', 'dialup', 'dial']);
// 复合词（dclient、adslplus、cablemodem、customers、dynip …）：整个词能拆成「家宽词 + 家宽词 / 下列词缀」才算，
// 拆出任何别的片段都不算（fiberhost = fiber + host ✗，liverpool = liver + pool ✗，dynect = dyn + ect ✗）。
const PTR_RES_AFFIX = new Set(['d', 's', 'x', 'plus', 'ip', 'ips', 'modem', 'net', 'line']);
const PTR_STATIC = ['static', 'fixed', 'business', 'biz'];
// 服务器 / 平台类词（整词，按「字母数字」切词以识别 k8s 等）→ 判为机房
const PTR_DC = new Set(['vps', 'vds', 'server', 'servers', 'srv', 'dedicated', 'colo', 'colocation', 'cloud', 'compute', 'ec2',
  'hosting', 'hosted', 'datacenter', 'gke', 'aks', 'eks', 'k8s', 'kube', 'kubernetes', 'cluster', 'baremetal']);
// 厂商域名（子串）：这些名字足够独特，不会出现在家宽 PTR 中
const PTR_DC_DOMAINS = ['googleusercontent', 'amazonaws', 'linode', 'vultr', 'hetzner', 'your-server.de', 'ovh.net',
  'contabo', 'digitalocean', 'leaseweb', 'choopa', 'akamaitechnologies'];
// 服务器类词的粘连写法（myvpsserver、webhosting、cloudprovider …）：在拆不开的词里按子串匹配，这些片段足够独特
const PTR_DC_SUB = ['hosting', 'server', 'vps', 'datacenter', 'dedicated', 'colocation', 'kubernetes', 'cloud'];
// 服务 / 基础设施类词（整词）：出现即不按家宽判断，但本身不足以判为机房。
// 只看「可注册域名」之前的标签（mx.dynect.net 的 mx 算；prod-infinitum.com.mx 的 mx 是国家后缀，不算）。
// host 例外：host 紧跟编号（host86-…、host-1-2-3-4）是英国 BT、比利时 VOO 等运营商的家宽写法，不屏蔽，见 classifyPtr。
const PTR_NOT_RES = new Set(['vpn', 'proxy', 'proxies', 'node', 'nodes', 'mail', 'mx', 'smtp', 'imap', 'pop', 'mta', 'host', 'hosts',
  'ns', 'dns', 'www', 'web', 'relay', 'tor', 'exit', 'cdn', 'edge', 'cache', 'lb', 'api', 'gw', 'gateway', 'router', 'core',
  'backbone', 'ix', 'peer', 'nat', 'cgnat', 'vm', 'container', 'worker', 'bot', 'crawl', 'crawler', 'scan', 'scanner']);
// 服务类词的粘连写法（webhost、vpnpool、myproxy …）：在拆不开的词里按子串匹配；只收足够长 / 独特的片段（不含 mx、ns 之类）
const PTR_NOT_RES_SUB = ['host', 'vpn', 'proxy', 'mail', 'smtp', 'relay', 'gateway', 'router', 'crawler', 'scanner'];
// 机房暗示词：本身不足以判机房（dc、rack 也可能是运营商机房 / 区域代号），但出现在主机部分时，
// 「host + 编号」不再按运营商家宽写法放行（dedi-host-1-2-3-4 → 无信号）。dedi 另按子串查（dedibox、mydedi）。
// dedicated / vps / server / srv / colo / cloud / hosting 等本来就是机房词，见 PTR_DC。
const PTR_DC_HINT = new Set(['dedi', 'ded', 'dc', 'rack', 'metal', 'bm', 'kvm', 'xen', 'virt', 'virtual']);
// 机房子串里较「弱」的：cloud 常见于运营商品牌（mcloud、cloudnet 等），PTR 同时有明确家宽词时只取消家宽判断，不判机房
const PTR_DC_SUB_WEAK = new Set(['cloud']);
// 国家顶级域下常见的二级后缀（com.mx、co.uk、net.br …），用来粗略确定「可注册域名」（不引入完整的公共后缀列表）
const PTR_SLD = new Set(['com', 'net', 'org', 'co', 'ne', 'or', 'ac', 'ad', 'go', 'gov', 'gob', 'edu', 'mil', 'nic', 'ltd', 'plc',
  'sch', 'info', 'biz', 'gen', 'nom', 'int']);

/** 把 PTR 拆成「主机部分」（可注册域名之前的标签）、可注册域名的名字标签、公共后缀 */
export function splitPtrLabels(low) {
  const labels = low.split('.').filter(Boolean);
  let suffix = labels.length > 1 ? 1 : 0;
  if (labels.length > 2 && /^[a-z]{2}$/.test(labels.at(-1)) && PTR_SLD.has(labels.at(-2))) suffix = 2;
  const regIdx = labels.length - suffix - 1; // 可注册域名的名字标签
  return { host: labels.slice(0, Math.max(regIdx, 0)), reg: regIdx >= 0 ? labels[regIdx] : null, suffix: labels.slice(labels.length - suffix) };
}

/** 词能否拆成 ≤3 段，且每段都是家宽词或词缀、至少一段是家宽词 */
function resCompound(t) {
  if (PTR_RES.has(t)) return t;
  const go = (rest, depth, hasRes, first) => {
    if (!rest) return hasRes ? first : null;
    if (depth === 3) return null;
    for (let i = rest.length; i >= 1; i--) {
      const piece = rest.slice(0, i);
      const isRes = PTR_RES.has(piece);
      if (!isRes && !PTR_RES_AFFIX.has(piece)) continue;
      const r = go(rest.slice(i), depth + 1, hasRes || isRes, first || (isRes ? piece : null));
      if (r) return r;
    }
    return null;
  };
  return go(t, 0, false, null);
}

/**
 * PTR 关键词判断：{ signal: 'residential'|'static'|'datacenter'|null, keyword, blockedBy? }
 * 优先级：服务器类 > 静态 / 商业 > 服务 / 基础设施词（不判家宽） > 家宽。
 * 公共后缀（net、com.mx、co.uk …）不参与任何关键词判断。
 */
export function classifyPtr(ptr) {
  if (!ptr) return { signal: null };
  const low = ptr.toLowerCase().replace(/\.$/, '');
  const { host, reg } = splitPtrLabels(low);
  const named = reg ? [...host, reg] : host; // 去掉公共后缀
  const namedStr = named.join('.');
  const hostStr = host.join('.');
  const tokensOf = (str) => str.split(/[^a-z]+/).filter(Boolean);
  const tokens = tokensOf(namedStr);
  const alnum = namedStr.split(/[^a-z0-9]+/).filter(Boolean);
  const words = [...new Set([...tokens, ...alnum])];
  // 拆不开的词：不是任何已知词、也不能拆成家宽复合词（webhost、cloudprovider、fiberhost …）
  const glued = tokens.filter((t) => !PTR_DC.has(t) && !PTR_NOT_RES.has(t) && !PTR_STATIC.includes(t) && !resCompound(t));

  const dc = words.find((t) => PTR_DC.has(t)) || PTR_DC_DOMAINS.find((k) => low.includes(k));
  if (dc) return { signal: 'datacenter', keyword: dc };
  const dcSub = PTR_DC_SUB.find((k) => glued.some((t) => t.includes(k)));
  if (dcSub) {
    // dsl.mcloud.ru：有明确家宽词时 cloud 子串只取消家宽判断（无信号）；cloudprovider 这类没有家宽词的仍判机房
    if (PTR_DC_SUB_WEAK.has(dcSub) && tokens.some((t) => resCompound(t))) return { signal: null, blockedBy: dcSub };
    return { signal: 'datacenter', keyword: dcSub };
  }
  const st = PTR_STATIC.find((k) => tokens.includes(k));
  if (st) return { signal: 'static', keyword: st };

  // host 紧跟编号：host86-…、host-1-2-3-4、host1 → 运营商按地址生成的名字，不屏蔽
  const hostNumbered = /(^|[^a-z0-9])host-?\d/.test(hostStr);
  const hostBare = /(^|[^a-z0-9])host(?!-?\d)(?![a-z])/.test(hostStr);
  const hostTokens = tokensOf(hostStr);
  // 主机部分有机房暗示词（dedi-host-1-2-3-4、host-1-2-3-4.dc2…）时，host + 编号不放行
  const dcHint = hostNumbered && (hostTokens.find((t) => PTR_DC_HINT.has(t)) || (hostTokens.some((t) => glued.includes(t) && t.includes('dedi')) ? 'dedi' : null));
  if (dcHint) return { signal: null, blockedBy: `host（${dcHint}）` };
  const block = hostTokens.find((t) => PTR_NOT_RES.has(t) && !(t === 'host' && !hostBare))
    || PTR_NOT_RES_SUB.reduce((hit, k) => hit || (glued.some((t) => t.includes(k)) ? k : null), null);
  if (block) return { signal: null, blockedBy: block };

  for (const t of tokens) {
    const k = resCompound(t);
    if (k) return { signal: 'residential', keyword: k === t ? k : `${k}（${t}）` };
  }
  // 没有其它家宽词时：host + IP 形式的编号（host86-128-12-34、host-1-2-3-4）按运营商家宽写法处理
  const hostIp = hostNumbered && hostStr.match(/(?:^|[^a-z0-9])(host-?\d{1,3}(?:[.-]\d{1,3}){1,3})/);
  if (hostIp) return { signal: 'residential', keyword: `host（${hostIp[1]}）` };
  return { signal: null };
}
