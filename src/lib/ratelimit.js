// 限流。没有 Origin 的请求（curl、脚本）不受 CORS 约束，真正的保护是限流。
// 优先使用 Cloudflare Rate Limiting 绑定（wrangler.toml 默认已启用三个），缺失时退回进程内计数
// （每个 isolate 独立，只能挡住最粗暴的刷接口），并在每个 isolate 里 console.warn 一次。
// 键：IPv4 按单个地址，IPv6 按 /64（与「本站观测」计数一致），绑定与进程内兜底都一样。
import { parseIP, subscriberKey } from './ip.js';

export const LIMITS = {
  self: { binding: 'SELF_LIMITER', env: 'SELF_RATE_LIMIT', def: 60, text: '查询自己的 IP' },
  lookup: { binding: 'LOOKUP_LIMITER', env: 'LOOKUP_RATE_LIMIT', def: 20, text: '查询其他 IP（?ip=）' },
  seen: { binding: 'SEEN_LIMITER', env: 'SEEN_RATE_LIMIT', def: 10, text: '上报设备（/api/seen）' },
};

/** 限流键：CF-Connecting-IP → v4:<ip> / v6/64:<前缀>；拿不到（本地开发）时为 'local' */
export function limiterKey(ip) {
  const k = subscriberKey(parseIP(ip));
  return k ? k.key : 'local';
}

/**
 * 本地开发放宽：仅在 DEV_MODE=true 时生效，RATE_LIMIT_MULTIPLIER（> 1）把阈值放大 N 倍。
 * 绑定的阈值写死在 wrangler.toml、运行时改不了，所以此时改用进程内计数（阈值 × N）。线上不受影响。
 */
export function devMultiplier(env) {
  if (env.DEV_MODE !== 'true') return 1;
  const m = Number(env.RATE_LIMIT_MULTIPLIER);
  return Number.isFinite(m) && m > 1 ? Math.min(m, 1000) : 1;
}

const hasBinding = (env, bucket) => { const b = env[LIMITS[bucket].binding]; return !!(b && typeof b.limit === 'function'); };
export function limiterMode(env, bucket) {
  if (devMultiplier(env) > 1) return 'memory-dev';
  return hasBinding(env, bucket) ? 'binding' : 'memory';
}
export const memLimit = (env, bucket) => (Number(env[LIMITS[bucket].env]) || LIMITS[bucket].def) * devMultiplier(env);

const warned = new Set();
function warnMissingLimiter(bucket) {
  if (warned.has(bucket)) return;
  warned.add(bucket);
  const c = LIMITS[bucket];
  console.warn(`[checkmyip] ⚠️ 未找到 Rate Limiting 绑定 ${c.binding}：「${c.text}」退回进程内限流（每 isolate 独立、可被轻易绕过）。请在 wrangler.toml 中配置 [[ratelimits]] ${c.binding}，详见 README「限流」。`);
}

const rl = new Map();
function memLimited(key, limit, now) {
  const e = rl.get(key);
  if (!e || now - e.t > 60_000) { rl.set(key, { t: now, n: 1 }); if (rl.size > 5000) rl.clear(); return false; }
  e.n += 1;
  return e.n > limit;
}
export function _resetMemLimiter() { rl.clear(); warned.clear(); }

/** @param ip 访问者 IP（CF-Connecting-IP），内部换算成 /64 等限流键 */
export async function rateLimited(env, bucket, ip, now = Date.now()) {
  const c = LIMITS[bucket];
  const key = `${bucket}:${limiterKey(ip)}`;
  if (devMultiplier(env) === 1) {
    if (hasBinding(env, bucket)) {
      try { const { success } = await env[c.binding].limit({ key }); return { limited: !success, via: 'binding', key }; }
      catch (e) { console.warn(`[checkmyip] Rate Limiting 绑定 ${c.binding} 调用失败，本次退回进程内计数：${e}`); }
    } else warnMissingLimiter(bucket);
  }
  return { limited: memLimited(key, memLimit(env, bucket), now), via: devMultiplier(env) > 1 ? 'memory-dev' : 'memory', key };
}

export function limiterHealth(env) {
  const m = devMultiplier(env);
  const rateLimit = Object.fromEntries(Object.entries(LIMITS).map(([k, c]) => [k, { binding: c.binding, mode: limiterMode(env, k), ...(m > 1 || !hasBinding(env, k) ? { limitPerMinute: memLimit(env, k) } : {}) }]));
  const warnings = Object.entries(rateLimit).filter(([, x]) => x.mode === 'memory')
    .map(([k, x]) => `未配置 Rate Limiting 绑定 ${x.binding}：「${LIMITS[k].text}」正在使用进程内限流（可被绕过）`);
  if (m > 1) warnings.push(`开发模式：RATE_LIMIT_MULTIPLIER=${m}，限流改用进程内计数、阈值 ×${m}（仅 DEV_MODE=true 时生效）`);
  return { rateLimit, keying: 'IPv4 按单个地址，IPv6 按 /64', warnings };
}
