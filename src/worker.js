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

const VERSION = '0.2.0';

// ---------- 小工具 ----------
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

// ---------- CORS 白名单 ----------
// 默认只允许同源；额外来源写在 ALLOWED_ORIGINS（逗号分隔，如 "https://a.com,https://b.com"）。
// v4.<域名> / v6.<域名> 探测子域自动允许其主域名；DEV_MODE 下允许 localhost / 127.0.0.1。
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
function originPolicy(request, env, url) {
  const origin = request.headers.get('origin');
  if (!origin || origin === url.origin) return { origin, allowed: true, cross: false };
  let host = null;
  try { host = new URL(origin).hostname; } catch { return { origin, allowed: false, cross: true }; }
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);
  const probeParent = url.hostname.match(/^v[46]\.(.+)$/)?.[1];
  const allowed = list.includes(origin)
    || (probeParent && host === probeParent && origin.startsWith('https://'))
    || (env.DEV_MODE === 'true' && LOCAL_HOSTS.has(host));
  return { origin, allowed: !!allowed, cross: true };
}
function withCors(resp, pol) {
  const r = new Response(resp.body, resp);
  r.headers.append('vary', 'Origin');
  if (pol.cross && pol.allowed) {
    r.headers.set('access-control-allow-origin', pol.origin);
    r.headers.set('access-control-allow-methods', 'GET, OPTIONS');
    r.headers.set('access-control-allow-headers', 'content-type');
    r.headers.set('access-control-max-age', '86400');
  }
  return r;
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

// 限流：优先使用 Cloudflare Rate Limiting 绑定（env.LOOKUP_LIMITER，见 wrangler.toml / README），
// 未配置时退回进程内计数（每个 isolate 独立，只能挡住最粗暴的刷接口）。
const rl = new Map();
async function rateLimited(env, who, limit) {
  const b = env.LOOKUP_LIMITER;
  if (b && typeof b.limit === 'function') {
    try { const { success } = await b.limit({ key: `lookup:${who}` }); return { limited: !success, via: 'binding' }; }
    catch { /* 绑定异常时退回内存计数 */ }
  }
  return { limited: memLimited(who, limit), via: 'memory' };
}
function memLimited(who, limit) {
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
  // 仅本地开发：DEV_SIMULATE_FAIL=true 时模拟所有外部查询失败，用于检查“数据不完整”状态
  const simulate = env.DEV_MODE === 'true' && env.DEV_SIMULATE_FAIL === 'true';
  const useCf = !simulate && cf && cf.asn && cf.country;

  // 外部数据（地理位置 + PTR）缓存
  const ext = simulate ? {
    geo: null, geoSource: null, cache: 'bypass (simulated)',
    attempts: String(env.GEO_PROVIDERS || 'ip.sb').split(',').map((x) => ({ source: x.trim(), ok: false, error: 'DEV_SIMULATE_FAIL' })),
    ptr: { ptr: null, source: null, error: 'DEV_SIMULATE_FAIL' },
  } : await cached(`v1:${useCf ? 'ptr' : 'full'}:${parsed.ip}`, ttl, ctx, async () => {
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
  const quality = { geoOk: !!(useCf || ext.geo), ptrOk: !ext.ptr?.error };
  const analysis = analyze({ cloud, asn: { asn: geo.asn, org: geo.org }, asnInfo, ptr: ptrInfo, tor, external, proxyHeaders, quality });

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
      reputation: analysis.reputation.used ? analysis.reputation.sources : null,
      ...(simulate ? { simulated: 'DEV_SIMULATE_FAIL' } : {}),
      cache: ext.cache,
      dataUpdatedAt: meta.generatedAt,
    },
    elapsedMs: Date.now() - t0,
  };
}

async function handleIp(request, env, ctx, url, pol) {
  const q = url.searchParams.get('ip');
  if (q) {
    // 查询任意 IP 会消耗外部接口额度：不在白名单的跨域来源直接拒绝
    if (!pol.allowed) return json({ ok: false, error: 'origin_not_allowed', message: '该来源不允许调用查询接口' }, 403);
    const parsed = parseIP(q);
    if (!parsed) return json({ ok: false, error: 'invalid_ip', message: '请输入有效的 IPv4 或 IPv6 地址' }, 400);
    const who = request.headers.get('cf-connecting-ip') || 'local';
    const rlr = await rateLimited(env, who, Number(env.LOOKUP_RATE_LIMIT) || 30);
    if (rlr.limited) return json({ ok: false, error: 'rate_limited', message: '查询过于频繁，请稍后再试' }, 429, { 'retry-after': '60', 'x-ratelimit-via': rlr.via });
    const bogon = bogonReason(parsed);
    if (bogon) return json({ ok: false, error: 'bogon', ip: parsed.ip, version: parsed.version, message: `${parsed.ip} 是${bogon}，不属于公网 IP，无法查询` }, 422);
    const data = await lookup(parsed, { env, ctx });
    return json({ ...data, query: 'lookup' }, 200, { 'x-ratelimit-via': rlr.via });
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

// v4.<域名> / v6.<域名>：只返回访问者 IP 的极简探测接口（这两个子域分别只配 A / AAAA 记录）
async function handleProbe(request, env, url) {
  if (url.pathname !== '/api/ip' && url.pathname !== '/') return json({ ok: false, error: 'not_found' }, 404);
  const v = await resolveVisitor(request, env);
  if (!v.parsed) return json({ ok: false, error: 'no_ip' }, 500);
  return json({ ok: true, ip: v.parsed.ip, version: v.parsed.version });
}

async function route(request, env, ctx, url, pol) {
  if (request.method === 'OPTIONS') return new Response(null, { status: pol.allowed ? 204 : 403 });
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (/^v[46]\./.test(url.hostname)) return handleProbe(request, env, url);
  if (url.pathname === '/api/ip') return handleIp(request, env, ctx, url, pol);
  if (url.pathname === '/api/health') return json({ ok: true, version: VERSION, time: new Date().toISOString() });
  if (url.pathname === '/api/meta') return json({ ok: true, version: VERSION, data: meta }, 200, { 'cache-control': 'public, max-age=3600' });
  return json({ ok: false, error: 'not_found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const probeHost = /^v[46]\./.test(url.hostname);
    if (url.pathname.startsWith('/api/') || probeHost) {
      const pol = originPolicy(request, env, url);
      try {
        return withCors(await route(request, env, ctx, url, pol), pol);
      } catch (e) {
        return withCors(json({ ok: false, error: 'internal', message: '服务器内部错误', detail: env.DEV_MODE === 'true' ? String(e.stack || e) : undefined }, 500), pol);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
