import { subscriberKey } from './ip.js';

// 「本站观测到的设备数」：Cloudflare D1（绑定名 DB），表结构见 migrations/0001_ip_seen.sql。
// 只保存 HMAC 截断哈希：ip_hash = HMAC(IP_HASH_SALT, IP)，fp_hash = HMAC(IP_HASH_SALT, 指纹哈希)；不保存原始 IP / 指纹。
// 没有盐就无法抵御对 IPv4 全地址空间的暴力还原，所以未配置 IP_HASH_SALT 时整个功能视为未启用。

export const SEEN_WINDOW_DAYS = 30;
export const SEEN_SHORT_DAYS = 7;
// 每个 ip_hash（IPv4 地址 / IPv6 /64）每天最多新记录多少个不同指纹。
// 防止有人用脚本伪造大量指纹刷高自己 IP 的「设备数」，也保护 D1 的写入额度：达到上限后不再写库。
export const SEEN_DAILY_CAP_DEFAULT = 30;
const HASH_BYTES = 16;
const FP_RE = /^[0-9a-f]{8,64}$/i;

export function seenStatus(env) {
  if (!env.DB || typeof env.DB.prepare !== 'function') return { enabled: false, reason: 'no_db', message: '本站统计未启用（未绑定 D1 数据库）' };
  if (!env.IP_HASH_SALT || String(env.IP_HASH_SALT).length < 16) return { enabled: false, reason: 'no_salt', message: '本站统计未启用（未设置 IP_HASH_SALT）' };
  return { enabled: true };
}

export function seenCap(env) {
  const n = Math.floor(Number(env.SEEN_DAILY_CAP));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 1000) : SEEN_DAILY_CAP_DEFAULT;
}

const keyCache = new Map();
async function hmacHex(secret, msg) {
  let key = keyCache.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(secret, key);
  }
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
  return [...sig.slice(0, HASH_BYTES)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** IPv4 按单个地址；IPv6 按 /64 前缀（与限流键相同，见 ip.js subscriberKey） */
export const ipKey = (parsed) => subscriberKey(parsed);
export const ipHash = (env, parsed) => hmacHex(env.IP_HASH_SALT, ipKey(parsed).key);
export const fpHash = (env, fp) => hmacHex(env.IP_HASH_SALT, `fp:${String(fp).toLowerCase()}`);
export const validFp = (fp) => typeof fp === 'string' && FP_RE.test(fp);

export function dayStr(t = Date.now(), minusDays = 0) {
  return new Date(t - minusDays * 86400_000).toISOString().slice(0, 10);
}

// 本 isolate 内已知「今天已满额」的 ip_hash：跳过计数与写入，只做一次主键点查判断「是否早已计入」。按天自然失效。
const cappedMemo = new Map();
const CAPPED_MEMO_MAX = 10_000;
export function _resetCappedMemo() { cappedMemo.clear(); }

/**
 * 记录一次「这个 IP 上出现了这个指纹」。
 * - 同日同指纹由主键去重；
 * - 同一 ip_hash 当天的新指纹达到上限（seenCap）后不再写入：先读当天行数，满额直接返回；
 *   写入语句本身也带条件（INSERT … SELECT … WHERE 当天行数 < 上限），并发请求也不会超出上限；
 * - 满额后记在本 isolate 的内存里，之后同 IP 当天的请求不再计数、不再写 D1，
 *   只按主键点查一次本指纹今天是否已计入（让满额前已计入的浏览器仍显示「已计入」）。
 * 返回 { inserted, capped, dup }
 */
export async function recordSeen(env, parsed, fp, now = Date.now()) {
  const cap = seenCap(env);
  const day = dayStr(now);
  const ih = await ipHash(env, parsed);
  const memoKey = `${ih}|${day}`;
  const fh = await fpHash(env, fp);
  if (cappedMemo.get(memoKey) === cap) {
    const hit = await env.DB.prepare('SELECT 1 AS x FROM ip_seen WHERE ip_hash = ?1 AND fp_hash = ?2 AND day = ?3').bind(ih, fh, day).first();
    return { inserted: false, capped: true, dup: !!hit, memo: true };
  }
  const row = await env.DB.prepare('SELECT COUNT(*) AS n, COUNT(CASE WHEN fp_hash = ?2 THEN 1 END) AS mine FROM ip_seen WHERE ip_hash = ?1 AND day = ?3')
    .bind(ih, fh, day).first();
  const n = Number(row?.n || 0);
  if (Number(row?.mine || 0) > 0) return { inserted: false, capped: n >= cap, dup: true };
  if (n >= cap) { remember(memoKey, cap); return { inserted: false, capped: true, dup: false }; }
  const r = await env.DB.prepare(
    'INSERT OR IGNORE INTO ip_seen (ip_hash, fp_hash, day) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM ip_seen WHERE ip_hash = ?1 AND day = ?3) < ?4',
  ).bind(ih, fh, day, cap).run();
  const inserted = (r?.meta?.changes ?? 0) > 0;
  // 没写进去又不是重复 → 并发下刚好被别的请求占满
  const capped = inserted ? n + 1 >= cap : true;
  if (capped) remember(memoKey, cap);
  return { inserted, capped, dup: false };
}
function remember(k, cap) {
  if (cappedMemo.size >= CAPPED_MEMO_MAX) cappedMemo.clear();
  cappedMemo.set(k, cap);
}

/** 近 30 天 / 近 7 天在该 IP（IPv6 为 /64）上出现过的不同指纹数 */
export async function countSeen(env, parsed, now = Date.now()) {
  const ih = await ipHash(env, parsed);
  const row = await env.DB.prepare(
    'SELECT COUNT(DISTINCT fp_hash) AS d30, COUNT(DISTINCT CASE WHEN day >= ?2 THEN fp_hash END) AS d7 FROM ip_seen WHERE ip_hash = ?1 AND day >= ?3',
  ).bind(ih, dayStr(now, SEEN_SHORT_DAYS - 1), dayStr(now, SEEN_WINDOW_DAYS - 1)).first();
  return { devices30d: Number(row?.d30 || 0), devices7d: Number(row?.d7 || 0), scope: ipKey(parsed).scope };
}

/** 删除 30 天前的数据（写入时惰性触发 + 每日 cron） */
export async function cleanupSeen(env, now = Date.now()) {
  const r = await env.DB.prepare('DELETE FROM ip_seen WHERE day < ?1').bind(dayStr(now, SEEN_WINDOW_DAYS - 1)).run();
  return { deleted: r?.meta?.changes ?? 0 };
}

// 每个 isolate 最多每小时做一次惰性清理
let lastCleanup = 0;
export function maybeCleanup(env, ctx, now = Date.now()) {
  if (now - lastCleanup < 3600_000) return false;
  lastCleanup = now;
  const p = cleanupSeen(env, now).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(p);
  return true;
}
