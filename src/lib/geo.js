// 地理位置 / ASN 查询：依次尝试多个免费、无需密钥的公共接口，每个 3 秒超时
import { fetchJSON } from './http.js';

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const asnNum = (v) => { const m = String(v ?? '').match(/(\d+)/); return m ? Number(m[1]) : null; };
const orgFromAsnStr = (v) => String(v ?? '').replace(/^AS\d+\s*/i, '').trim() || null;

export const PROVIDERS = {
  'ip.sb': {
    url: (ip) => `https://api.ip.sb/geoip/${ip}`,
    map: (d) => d && d.ip && {
      countryCode: d.country_code, country: d.country, region: d.region, city: d.city,
      lat: num(d.latitude), lon: num(d.longitude), timezone: d.timezone,
      asn: asnNum(d.asn), org: d.asn_organization || d.organization, isp: d.isp,
    },
  },
  'ipwho.is': {
    url: (ip) => `https://ipwho.is/${ip}?lang=zh-CN`,
    map: (d) => d && d.success && {
      countryCode: d.country_code, country: d.country, region: d.region, city: d.city,
      lat: num(d.latitude), lon: num(d.longitude), timezone: d.timezone?.id,
      asn: asnNum(d.connection?.asn), org: d.connection?.org, isp: d.connection?.isp,
    },
  },
  geojs: {
    url: (ip) => `https://get.geojs.io/v1/ip/geo/${ip}.json`,
    map: (d) => d && d.ip && {
      countryCode: d.country_code, country: d.country, region: d.region, city: d.city,
      lat: num(d.latitude), lon: num(d.longitude), timezone: d.timezone,
      asn: asnNum(d.asn), org: d.organization_name || orgFromAsnStr(d.organization),
    },
  },
  'ipapi.is': {
    url: (ip, env) => `https://api.ipapi.is/?q=${ip}${env.IPAPI_IS_KEY ? `&key=${encodeURIComponent(env.IPAPI_IS_KEY)}` : ''}`,
    map: (d) => d && d.ip && {
      countryCode: d.location?.country_code, country: d.location?.country ?? d.country,
      region: d.location?.state ?? d.region, city: d.location?.city ?? d.city,
      lat: num(d.location?.latitude ?? d.lat), lon: num(d.location?.longitude ?? d.lon),
      timezone: d.location?.timezone ?? d.timezone,
      asn: typeof d.asn === 'object' ? d.asn?.asn : asnNum(d.asn),
      org: typeof d.asn === 'object' ? d.asn?.org : orgFromAsnStr(d.asn),
      isp: typeof d.company === 'object' ? d.company?.name : d.company,
    },
  },
  ipinfo: {
    url: (ip, env) => `https://ipinfo.io/${ip}/json${env.IPINFO_TOKEN ? `?token=${encodeURIComponent(env.IPINFO_TOKEN)}` : ''}`,
    map: (d) => d && d.ip && !d.bogon && {
      countryCode: d.country, region: d.region, city: d.city,
      lat: num(d.loc?.split(',')[0]), lon: num(d.loc?.split(',')[1]), timezone: d.timezone,
      asn: asnNum(d.org), org: orgFromAsnStr(d.org),
    },
  },
  'ipapi.co': {
    url: (ip) => `https://ipapi.co/${ip}/json/`,
    map: (d) => d && d.ip && !d.error && {
      countryCode: d.country_code, country: d.country_name, region: d.region, city: d.city,
      lat: num(d.latitude), lon: num(d.longitude), timezone: d.timezone, asn: asnNum(d.asn), org: d.org,
    },
  },
  // ip-api.com 免费版仅 HTTP 且限非商用，只作为最后手段（默认不启用）
  'ip-api': {
    url: (ip) => `http://ip-api.com/json/${ip}?fields=status,countryCode,country,regionName,city,lat,lon,timezone,as,org,isp`,
    map: (d) => d && d.status === 'success' && {
      countryCode: d.countryCode, country: d.country, region: d.regionName, city: d.city,
      lat: num(d.lat), lon: num(d.lon), timezone: d.timezone, asn: asnNum(d.as), org: d.org || orgFromAsnStr(d.as), isp: d.isp,
    },
  },
};

const DEFAULT_ORDER = 'ip.sb,ipwho.is,geojs,ipapi.is,ipinfo,ipapi.co';

/** 返回 { geo, source, attempts }，geo 字段可能部分为空 */
export async function lookupGeo(ip, env = {}) {
  const order = String(env.GEO_PROVIDERS || DEFAULT_ORDER).split(',').map((s) => s.trim()).filter((s) => PROVIDERS[s]);
  const attempts = [];
  let geo = null, source = null;
  for (const name of order) {
    const p = PROVIDERS[name];
    const t0 = Date.now();
    const r = await fetchJSON(p.url(ip, env), { timeout: Number(env.LOOKUP_TIMEOUT_MS) || 3000 });
    const g = r.ok ? p.map(r.data) : null;
    attempts.push({ source: name, ok: !!g, ms: Date.now() - t0, ...(g ? {} : { error: r.error || r.status || '无有效数据' }) });
    if (!g) continue;
    if (!geo) { geo = g; source = name; } else {
      for (const k of Object.keys(g)) if (geo[k] == null || geo[k] === '') geo[k] = g[k];
      source += '+' + name;
    }
    if (geo.countryCode && geo.asn && geo.org) break;
  }
  return { geo, source, attempts };
}
