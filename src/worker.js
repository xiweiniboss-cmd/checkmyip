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
import { rateLimited, limiterHealth } from './lib/ratelimit.js';
import { estimateSharing } from './lib/sharing.js';
import { seenStatus, seenCap, seenGlobalCap, globalPausedToday, SEEN_PAUSED_MESSAGE, recordSeen, countSeen, cleanupSeen, maybeCleanup, validFp, SEEN_WINDOW_DAYS, SEEN_SHORT_DAYS } from './lib/seen.js';
import meta from './data/meta.json';

const VERSION = '0.4.1';

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

// ---------- 限流（逻辑见 src/lib/ratelimit.js：IPv4 按地址、IPv6 按 /64）----------
const tooMany = (rlr) => json({ ok: false, error: 'rate_limited', message: '请求过于频繁，请稍后再试' }, 429, { 'retry-after': '60', 'x-ratelimit-via': rlr.via });
const clientIp = (request) => request.headers.get('cf-connecting-ip');

// ---------- 访问者 IP ----------
// 线上只信 CF-Connecting-IP；本地开发（DEV_MODE=true 或拿到的是内网地址）用 DEV_IP 模拟访问者。
// 不再向任何第三方「查询本机出口 IP」：与线上行为一致，也不把开发机 IP 发给外部服务。
async function resolveVisitor(request, env) {
  const h = request.headers.get('cf-connecting-ip');
  const p = parseIP(h);
  if (p && !bogonReason(p) && env.DEV_MODE !== 'true') return { parsed: p, via: 'cf-connecting-ip', trustCf: true };
  if (env.DEV_IP) { const d = parseIP(env.DEV_IP); if (d) return { parsed: d, via: 'DEV_IP', trustCf: false }; }
  // DEV_MODE 下若请求本身带着公网 CF-Connecting-IP（如通过隧道访问），照样使用
  if (p && !bogonReason(p)) return { parsed: p, via: 'cf-connecting-ip', trustCf: false };
  return { parsed: p, via: h ? 'cf-connecting-ip' : 'none', trustCf: false, hint: env.DEV_MODE === 'true' ? '本地开发请在 .dev.vars 设置 DEV_IP=<要模拟的公网 IP>' : null };
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
  const sharing = estimateSharing({ ip: parsed.ip, version: parsed.version, countryCode: geo.countryCode, asnInfo, ptr: ptrInfo, cloud, tor, external, analysis });

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
    sharing,
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
    const rlr = await rateLimited(env, 'lookup', clientIp(request));
    if (rlr.limited) return tooMany(rlr);
    const bogon = bogonReason(parsed);
    if (bogon) return json({ ok: false, error: 'bogon', ip: parsed.ip, version: parsed.version, message: `${parsed.ip} 是${bogon}，不属于公网 IP，无法查询` }, 422);
    const data = await lookup(parsed, { env, ctx });
    // 隐私：本站观测数只对访问者自己的 IP 显示，避免通过 ?ip= 打听某个 IP 是否来过本站
    data.sharing.observed = { shown: false, reason: 'not_self', message: '本站观测数只对你自己的 IP 显示' };
    return json({ ...data, query: 'lookup' }, 200, { 'x-ratelimit-via': rlr.via });
  }
  const rlr = await rateLimited(env, 'self', clientIp(request));
  if (rlr.limited) return tooMany(rlr);
  const v = await resolveVisitor(request, env);
  if (!v.parsed) return json({ ok: false, error: 'no_ip', message: v.hint ? `无法确定访问者 IP：${v.hint}` : '无法确定访问者 IP' }, v.hint ? 422 : 500);
  const bogon = bogonReason(v.parsed);
  if (bogon) return json({ ok: false, error: 'bogon', ip: v.parsed.ip, message: `检测到的 IP ${v.parsed.ip} 是${bogon}${v.hint ? `；${v.hint}` : ''}` }, 422);
  const cf = v.trustCf ? request.cf : null;
  const data = await lookup(v.parsed, { env, ctx, cf, proxyHeaders: v.trustCf ? proxyHeaderHints(request) : [] });
  data.sharing.observed = await observedFor(env, v.parsed);
  return json({
    ...data,
    query: 'self',
    seenVia: v.via,
    connection: cf ? { colo: cf.colo, httpProtocol: cf.httpProtocol, tlsVersion: cf.tlsVersion, rttMs: cf.clientTcpRtt ?? null } : null,
  }, 200, { 'x-ratelimit-via': rlr.via });
}

// ---------- 本站观测到的设备数（D1）----------
async function observedFor(env, parsed) {
  const st = seenStatus(env);
  if (!st.enabled) return { shown: true, enabled: false, reason: st.reason, message: st.message };
  try {
    const c = await countSeen(env, parsed);
    return { shown: true, enabled: true, ...c, windowDays: SEEN_WINDOW_DAYS, shortDays: SEEN_SHORT_DAYS, dailyCap: seenCap(env), pausedToday: globalPausedToday(env) };
  } catch (e) {
    console.warn(`[checkmyip] D1 查询失败：${e}`);
    return { shown: true, enabled: false, reason: 'db_error', message: '本站统计暂时不可用' };
  }
}

// POST /api/seen  { fp: "<浏览器端指纹哈希>" }：仅限同源、限流、同一 IP + 指纹每天只记一次
async function handleSeen(request, env, ctx, url) {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (!origin || origin !== url.origin || (site && site !== 'same-origin')) return json({ ok: false, error: 'origin_not_allowed', message: '仅限本站页面调用' }, 403);
  if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) return json({ ok: false, error: 'bad_content_type' }, 415);
  const rlr = await rateLimited(env, 'seen', clientIp(request));
  if (rlr.limited) return tooMany(rlr);
  const st = seenStatus(env);
  if (!st.enabled) return json({ ok: true, enabled: false, reason: st.reason, message: st.message });
  const raw = await request.text();
  if (raw.length > 512) return json({ ok: false, error: 'too_large' }, 413);
  let fp = null;
  try { fp = JSON.parse(raw).fp; } catch { /* 下面统一报错 */ }
  if (!validFp(fp)) return json({ ok: false, error: 'invalid_fp', message: 'fp 必须是 8–64 位十六进制哈希' }, 400);
  const v = await resolveVisitor(request, env);
  if (!v.parsed || bogonReason(v.parsed)) return json({ ok: false, error: 'no_ip', message: v.hint ? `无法确定访问者 IP：${v.hint}` : '无法确定访问者 IP' }, 422);
  try {
    const r = await recordSeen(env, v.parsed, fp);
    maybeCleanup(env, ctx);
    const c = await countSeen(env, v.parsed);
    // 全站今日写入达上限：统计暂停（只影响「本站观测」，IP 检测照常）
    const pause = r.paused ? { paused: true, pausedReason: 'global_cap', message: SEEN_PAUSED_MESSAGE } : { paused: false };
    return json({ ok: true, enabled: true, recorded: r.inserted, alreadyCounted: r.dup === true, capped: r.capped, ...pause,
      observed: { shown: true, enabled: true, ...c, windowDays: SEEN_WINDOW_DAYS, shortDays: SEEN_SHORT_DAYS, dailyCap: seenCap(env), cappedToday: r.capped, pausedToday: !!r.paused } }, 200, { 'x-ratelimit-via': rlr.via });
  } catch (e) {
    console.warn(`[checkmyip] D1 写入失败：${e}`);
    return json({ ok: false, enabled: false, error: 'db_error', message: '本站统计暂时不可用' }, 503);
  }
}

function health(env) {
  const { rateLimit, keying, warnings } = limiterHealth(env);
  const seen = seenStatus(env);
  if (!seen.enabled) warnings.push(seen.message);
  return { ok: true, version: VERSION, time: new Date().toISOString(), rateLimit, rateLimitKey: keying,
    seen: { enabled: seen.enabled, reason: seen.reason || null, dailyNewDeviceCap: seenCap(env), globalDailyCap: seenGlobalCap(env), pausedToday: seen.enabled ? globalPausedToday(env) : false }, warnings };
}

// v4.<域名> / v6.<域名>：只返回访问者 IP 的极简探测接口（这两个子域分别只配 A / AAAA 记录）
async function handleProbe(request, env, url) {
  if (url.pathname !== '/api/ip' && url.pathname !== '/') return json({ ok: false, error: 'not_found' }, 404);
  const v = await resolveVisitor(request, env);
  if (!v.parsed) return json({ ok: false, error: 'no_ip' }, 500);
  return json({ ok: true, ip: v.parsed.ip, version: v.parsed.version });
}

async function route(request, env, ctx, url, pol) {
  if (request.method === 'OPTIONS') return new Response(null, { status: pol.allowed && url.pathname !== '/api/seen' ? 204 : 403 });
  if (/^v[46]\./.test(url.hostname)) return request.method === 'GET' || request.method === 'HEAD' ? handleProbe(request, env, url) : json({ ok: false, error: 'method_not_allowed' }, 405);
  if (url.pathname === '/api/seen') return request.method === 'POST' ? handleSeen(request, env, ctx, url) : json({ ok: false, error: 'method_not_allowed' }, 405, { allow: 'POST' });
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (url.pathname === '/api/ip') return handleIp(request, env, ctx, url, pol);
  if (url.pathname === '/api/health') return json(health(env));
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
  // 每日 cron（见 wrangler.toml [triggers]）：删除 30 天前的观测记录
  async scheduled(event, env, ctx) {
    if (!seenStatus(env).enabled) return;
    ctx.waitUntil(cleanupSeen(env).then((r) => console.log(`[checkmyip] 清理 ip_seen：删除 ${r.deleted} 行`)).catch((e) => console.warn(`[checkmyip] 清理失败：${e}`)));
  },
};
