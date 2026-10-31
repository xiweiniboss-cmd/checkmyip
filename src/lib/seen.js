// 「本站观测到的设备数」：Cloudflare D1（绑定名 DB），表结构见 migrations/0001_ip_seen.sql。
// 只保存 HMAC 截断哈希：ip_hash = HMAC(IP_HASH_SALT, IP)，fp_hash = HMAC(IP_HASH_SALT, 指纹哈希)；不保存原始 IP / 指纹。
// 没有盐就无法抵御对 IPv4 全地址空间的暴力还原，所以未配置 IP_HASH_SALT 时整个功能视为未启用。

export const SEEN_WINDOW_DAYS = 30;
export const SEEN_SHORT_DAYS = 7;
const HASH_BYTES = 16;
const FP_RE = /^[0-9a-f]{8,64}$/i;

export function seenStatus(env) {
  if (!env.DB || typeof env.DB.prepare !== 'function') return { enabled: false, reason: 'no_db', message: '本站统计未启用（未绑定 D1 数据库）' };
  if (!env.IP_HASH_SALT || String(env.IP_HASH_SALT).length < 16) return { enabled: false, reason: 'no_salt', message: '本站统计未启用（未设置 IP_HASH_SALT）' };
  return { enabled: true };
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

/** IPv4 按单个地址；IPv6 按 /64 前缀（同一户的设备各有不同 IPv6 地址，但通常共用一个 /64） */
export function ipKey(parsed) {
  if (parsed.version === 4) return { key: `v4:${parsed.ip}`, scope: 'ip' };
  return { key: `v6/64:${(parsed.v6 >> 64n).toString(16).padStart(16, '0')}`, scope: '/64' };
}
export const ipHash = (env, parsed) => hmacHex(env.IP_HASH_SALT, ipKey(parsed).key);
export const fpHash = (env, fp) => hmacHex(env.IP_HASH_SALT, `fp:${String(fp).toLowerCase()}`);
export const validFp = (fp) => typeof fp === 'string' && FP_RE.test(fp);

export function dayStr(t = Date.now(), minusDays = 0) {
  return new Date(t - minusDays * 86400_000).toISOString().slice(0, 10);
}

/** 记录一次「这个 IP 上出现了这个指纹」。同日重复写入被主键去重（INSERT OR IGNORE）。 */
export async function recordSeen(env, parsed, fp, now = Date.now()) {
  const [ih, fh] = await Promise.all([ipHash(env, parsed), fpHash(env, fp)]);
  const r = await env.DB.prepare('INSERT OR IGNORE INTO ip_seen (ip_hash, fp_hash, day) VALUES (?1, ?2, ?3)').bind(ih, fh, dayStr(now)).run();
  return { inserted: (r?.meta?.changes ?? 0) > 0 };
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
