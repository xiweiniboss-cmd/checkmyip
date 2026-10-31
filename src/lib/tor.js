// Tor 出口节点：优先使用在线列表（Cloudflare 边缘缓存 1 小时），失败则使用构建时内置列表
import bundled from '../data/tor-exits.json';
import { fetchText } from './http.js';

const URL_TOR = 'https://check.torproject.org/torbulkexitlist';
let mem = { set: null, at: 0, source: null };

export async function torSet(env = {}) {
  const ttl = 3600_000;
  if (mem.set && Date.now() - mem.at < ttl) return mem;
  if (env.TOR_LIVE !== 'false') {
    const r = await fetchText(URL_TOR, { timeout: 3000, cf: { cacheTtl: 3600, cacheEverything: true } });
    if (r.ok) {
      const ips = r.data.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
      if (ips.length > 100) { mem = { set: new Set(ips), at: Date.now(), source: 'live', count: ips.length }; return mem; }
    }
  }
  mem = { set: new Set(bundled.ips), at: Date.now() - ttl + 600_000, source: 'bundled', count: bundled.ips.length, updatedAt: bundled.updatedAt };
  return mem;
}

export async function isTorExit(ip, env) {
  const t = await torSet(env);
  return { tor: t.set.has(ip), source: t.source, count: t.count };
}
