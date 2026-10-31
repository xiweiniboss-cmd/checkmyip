// checkmyip — Cloudflare Worker 入口
// /api/*  由 Worker 处理；其余请求交给静态资源（public/）
import { parseIP, bogonReason } from './lib/ip.js';
import { matchCloud } from './lib/ranges.js';
import { classifyAsn, classifyPtr } from './lib/asn.js';
import { lookupGeo } from './lib/geo.js';
import { lookupPtr } from './lib/ptr.js';
import { isTorExit } from './lib/tor.js';
import { externalRisk } from './lib/external.js';
import { analyze } from './lib/score.js';
import { fetchText } from './lib/http.js';
import meta from './data/meta.json';

const VERSION = '0.1.0';

// ---------- 小工具 ----------
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...extra },
  });
}

let regionNames = null;
function countryZh(code) {
  if (!code) return null;
  try { regionNames ??= new Intl.DisplayNames(['zh-CN'], { type: 'region' }); return regionNames.of(String(code).toUpperCase()); }
  catch { return null; }
}

// 进程内 LRU 缓存（每个 isolate 独立），再叠加 Cache API（同一机房共享）
const mem = new Map();
const MEM_MAX = 1000;
function memGet(k) { const v = mem.get(k); if (!v) return null; if (v.exp < Date.now()) { mem.delete(k); return null; } mem.delete(k); mem.set(k, v); return v.data; }
function memSet(k, data, ttl) { mem.set(k, { data, exp: Date.now() + ttl * 1000 }); if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value); }

async function cached(key, ttl, ctx, producer) {
  const hit = memGet(key);
  if (hit) return { ...hit, cache: 'memory' };
  const cacheKey = new Request(`https://cache.checkmyip.internal/${encodeURIComponent(key)}`);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    try {
      const r = await cache.match(cacheKey);
      if (r) { const data = await r.json(); memSet(key, data, ttl); return { ...data, cache: 'edge' }; }
    } catch { /* 忽略缓存错误 */ }
  }
  const data = await producer();
  if (data && data.cacheable !== false) {
    memSet(key, data, ttl);
    if (cache) ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(data), { headers: { 'cache-control': `public, max-age=${ttl}` } })).catch(() => {}));
  }
  return { ...data, cache: 'miss' };
}

// 简单限流：每个访问者每分钟最多 N 次“查询其他 IP”（单 isolate 粗略计数）
const rl = new Map();
function rateLimited(who, limit) {
  const now = Date.now();
  const e = rl.get(who);
  if (!e || now - e.t > 60_000) { rl.set(who, { t: now, n: 1 }); if (rl.size > 5000) rl.clear(); return false; }
  e.n += 1;
  return e.n > limit;
}

// ---------- 访问者 IP ----------
async function resolveVisitor(request, env) {
  const h = request.headers.get('cf-connecting-ip');
  const p = parseIP(h);
  if (p && !bogonReason(p) && env.DEV_MODE !== 'true') return { parsed: p, via: 'cf-connecting-ip', trustCf: true };
  // 本地开发：CF-Connecting-IP 缺失或为内网地址
  if (env.DEV_IP) { const d = parseIP(env.DEV_IP); if (d) return { parsed: d, via: 'DEV_IP', trustCf: false }; }
  for (const u of ['https://api-ipv4.ip.sb/ip', 'https://api.ipify.org']) {
    const r = await fetchText(u, { timeout: 3000 });
    const d = r.ok && parseIP(r.data.trim());
    if (d) return { parsed: d, via: `dev-fallback (${new URL(u).host})`, trustCf: false };
  }
  return { parsed: p, via: h ? 'cf-connecting-ip' : 'none', trustCf: false };
}

function proxyHeaderHints(request) {
  const hints = [];
  const h = request.headers;
  if (h.get('via')) hints.push('Via');
  if (h.get('forwarded')) hints.push('Forwarded');
  const xff = h.get('x-forwarded-for');
  if (xff && xff.split(',').length > 1) hints.push('多级 X-Forwarded-For');
  if (h.get('proxy-connection')) hints.push('Proxy-Connection');
  return hints;
}

// ---------- 核心查询 ----------
async function lookup(parsed, { env, ctx, cf, proxyHeaders = [] }) {
  const t0 = Date.now();
  const ttl = Number(env.CACHE_TTL) || 21600;
  const useCf = cf && cf.asn && cf.country;

  // 外部数据（地理位置 + PTR）缓存
  const ext = await cached(`v1:${useCf ? 'ptr' : 'full'}:${parsed.ip}`, ttl, ctx, async () => {
    const [g, ptr] = await Promise.all([useCf ? Promise.resolve(null) : lookupGeo(parsed.ip, env), lookupPtr(parsed, env)]);
    return { geo: g?.geo || null, geoSource: g?.source || null, attempts: g?.attempts || [], ptr,
      cacheable: useCf ? !!ptr.source : !!g?.geo };
  });

  let geo, geoSource;
  if (useCf) {
    geo = { countryCode: cf.country, region: cf.region, city: cf.city, lat: Number(cf.latitude) || null,
      lon: Number(cf.longitude) || null, timezone: cf.timezone, asn: cf.asn, org: cf.asOrganization };
    geoSource = 'cloudflare (request.cf)';
  } else { geo = ext.geo || {}; geoSource = ext.geoSource; }

  const [tor, external] = await Promise.all([isTorExit(parsed.ip, env), externalRisk(parsed.ip, env)]);
  const cloud = matchCloud(parsed);
  const asnInfo = classifyAsn(geo.asn, geo.org || geo.isp);
  const ptrInfo = { ...ext.ptr, ...classifyPtr(ext.ptr?.ptr) };
  const analysis = analyze({ cloud, asn: { asn: geo.asn, org: geo.org }, asnInfo, ptr: ptrInfo, tor, external, proxyHeaders });

  return {
    ok: true,
    ip: parsed.ip,
    version: parsed.version,
    location: {
      countryCode: geo.countryCode || null,
      country: countryZh(geo.countryCode) || geo.country || null,
      countryEn: geo.country || null,
      region: geo.region || null,
      city: geo.city || null,
      latitude: geo.lat ?? null,
      longitude: geo.lon ?? null,
      timezone: geo.timezone || null,
    },
    network: {
      asn: geo.asn || null,
      org: geo.org || null,
      isp: geo.isp || null,
      asnName: asnInfo.by === 'asn' ? asnInfo.name : null,
      ptr: ext.ptr?.ptr || null,
      cloudProvider: cloud.map((c) => c.name),
    },
    analysis,
    sources: {
      geo: geoSource,
      geoAttempts: useCf ? [] : ext.attempts,
      ptr: ext.ptr?.source || null,
      tor: tor.source,
      external: external.map((x) => ({ source: x.source, ok: x.ok })),
      cache: ext.cache,
      dataUpdatedAt: meta.generatedAt,
    },
    elapsedMs: Date.now() - t0,
  };
}

async function handleIp(request, env, ctx, url) {
  const q = url.searchParams.get('ip');
  if (q) {
    const parsed = parseIP(q);
    if (!parsed) return json({ ok: false, error: 'invalid_ip', message: '请输入有效的 IPv4 或 IPv6 地址' }, 400);
    const who = request.headers.get('cf-connecting-ip') || 'local';
    if (rateLimited(who, Number(env.LOOKUP_RATE_LIMIT) || 30)) return json({ ok: false, error: 'rate_limited', message: '查询过于频繁，请稍后再试' }, 429);
    const bogon = bogonReason(parsed);
    if (bogon) return json({ ok: false, error: 'bogon', ip: parsed.ip, version: parsed.version, message: `${parsed.ip} 是${bogon}，不属于公网 IP，无法查询` }, 422);
    const data = await lookup(parsed, { env, ctx });
    return json({ ...data, query: 'lookup' });
  }
  const v = await resolveVisitor(request, env);
  if (!v.parsed) return json({ ok: false, error: 'no_ip', message: '无法确定访问者 IP' }, 500);
  const bogon = bogonReason(v.parsed);
  if (bogon) return json({ ok: false, error: 'bogon', ip: v.parsed.ip, message: `检测到的 IP ${v.parsed.ip} 是${bogon}` }, 422);
  const cf = v.trustCf ? request.cf : null;
  const data = await lookup(v.parsed, { env, ctx, cf, proxyHeaders: v.trustCf ? proxyHeaderHints(request) : [] });
  return json({
    ...data,
    query: 'self',
    seenVia: v.via,
    connection: cf ? { colo: cf.colo, httpProtocol: cf.httpProtocol, tlsVersion: cf.tlsVersion, rttMs: cf.clientTcpRtt ?? null } : null,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405);
      try {
        if (url.pathname === '/api/ip') return await handleIp(request, env, ctx, url);
        if (url.pathname === '/api/health') return json({ ok: true, version: VERSION, time: new Date().toISOString() });
        if (url.pathname === '/api/meta') return json({ ok: true, version: VERSION, data: meta }, 200, { 'cache-control': 'public, max-age=3600' });
        return json({ ok: false, error: 'not_found' }, 404);
      } catch (e) {
        return json({ ok: false, error: 'internal', message: '服务器内部错误', detail: env.DEV_MODE === 'true' ? String(e.stack || e) : undefined }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
