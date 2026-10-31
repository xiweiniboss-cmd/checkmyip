// 可选的第三方风险接口：仅在配置了对应密钥（环境变量 / secret）时调用
import { fetchJSON } from './http.js';

export async function externalRisk(ip, env = {}) {
  const tasks = [];
  const timeout = Number(env.LOOKUP_TIMEOUT_MS) || 3000;
  if (env.IPAPI_IS_KEY) tasks.push((async () => {
    const r = await fetchJSON(`https://api.ipapi.is/?q=${ip}&key=${encodeURIComponent(env.IPAPI_IS_KEY)}`, { timeout });
    if (!r.ok) return { source: 'ipapi.is', ok: false };
    const d = r.data;
    return { source: 'ipapi.is', ok: true, vpn: !!d.is_vpn, proxy: !!d.is_proxy, tor: !!d.is_tor,
      datacenter: !!d.is_datacenter, abuser: !!d.is_abuser, mobile: !!d.is_mobile, companyType: d.company?.type };
  })());
  if (env.PROXYCHECK_KEY) tasks.push((async () => {
    const r = await fetchJSON(`https://proxycheck.io/v2/${ip}?key=${encodeURIComponent(env.PROXYCHECK_KEY)}&vpn=1&risk=1`, { timeout });
    const d = r.ok && r.data?.[ip];
    if (!d) return { source: 'proxycheck.io', ok: false };
    return { source: 'proxycheck.io', ok: true, proxy: d.proxy === 'yes', proxyType: d.type, risk: Number(d.risk) || 0 };
  })());
  if (env.ABUSEIPDB_KEY) tasks.push((async () => {
    const r = await fetchJSON(`https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`,
      { timeout, headers: { Key: env.ABUSEIPDB_KEY } });
    const d = r.ok && r.data?.data;
    if (!d) return { source: 'abuseipdb', ok: false };
    return { source: 'abuseipdb', ok: true, abuseScore: d.abuseConfidenceScore, usageType: d.usageType, reports: d.totalReports, tor: !!d.isTor };
  })());
  return Promise.all(tasks);
}
