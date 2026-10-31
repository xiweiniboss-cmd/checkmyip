// 通过 DNS-over-HTTPS (JSON) 查询反向解析 PTR
import { fetchJSON } from './http.js';
import { ptrName } from './ip.js';

const RESOLVERS = [
  ['cloudflare-dns', (n) => `https://cloudflare-dns.com/dns-query?name=${n}&type=PTR`],
  ['dns.google', (n) => `https://dns.google/resolve?name=${n}&type=PTR`],
];

export async function lookupPtr(parsed, env = {}) {
  const name = ptrName(parsed);
  for (const [src, url] of RESOLVERS) {
    const r = await fetchJSON(url(name), { timeout: Number(env.LOOKUP_TIMEOUT_MS) || 3000, headers: { accept: 'application/dns-json' } });
    if (!r.ok) continue;
    const ans = (r.data.Answer || []).filter((a) => a.type === 12).map((a) => a.data.replace(/\.$/, ''));
    return { ptr: ans[0] || null, source: src, status: r.data.Status }; // Status 3 = NXDOMAIN
  }
  return { ptr: null, source: null, error: 'DoH 查询失败' };
}
