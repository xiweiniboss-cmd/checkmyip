import { subscriberKey } from './ip.js';

// 「本站观测到的设备数」：Cloudflare D1（绑定名 DB），表结构见 migrations/0001_ip_seen.sql。
// 只保存 HMAC 截断哈希：ip_hash = HMAC(IP_HASH_SALT, IP)，fp_hash = HMAC(IP_HASH_SALT, 指纹哈希)；不保存原始 IP / 指纹。
// 没有盐就无法抵御对 IPv4 全地址空间的暴力还原，所以未配置 IP_HASH_SALT 时整个功能视为未启用。

export const SEEN_WINDOW_DAYS = 30;
export const SEEN_SHORT_DAYS = 7;
// 每个 ip_hash（IPv4 地址 / IPv6 /64）每天最多新记录多少个不同指纹。
// 防止有人用脚本伪造大量指纹刷高自己 IP 的「设备数」，也保护 D1 的写入额度：达到上限后不再写库。
export const SEEN_DAILY_CAP_DEFAULT = 30;
// 全站每天最多新写入多少行 ip_seen（所有 IP 合计），达到后当天暂停统计（IP 检测不受影响），UTC 0 点自动恢复。
// D1 免费额度为每天 10 万「写入行」，且索引行也计入：每新增 1 行 ≈ 表 1 + day 索引 1 + 计数器 1 = 3 行写入，
// 30 天后清理删除再 ≈ 2 行；默认 15000 → 最坏约 15000×3 + 15000×2 = 7.5 万行/天，留出余量。
export const SEEN_GLOBAL_DAILY_CAP_DEFAULT = 15000;
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

export function seenGlobalCap(env) {
  const n = Math.floor(Number(env.SEEN_GLOBAL_DAILY_CAP));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 10_000_000) : SEEN_GLOBAL_DAILY_CAP_DEFAULT;
}
export const SEEN_PAUSED_MESSAGE = '本站统计今日已暂停（全站今日新增记录已达上限），UTC 0 点（北京时间 8 点）自动恢复；IP 检测不受影响';

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
// 本 isolate 内已知「全站今天已暂停」：之后的请求不再读计数器、不再写，只做一次主键点查。
let globalPaused = null; // `${day}|${globalCap}`
export function _resetCappedMemo() { cappedMemo.clear(); globalPaused = null; }
export const globalPausedToday = (env, now = Date.now()) => globalPaused === `${dayStr(now)}|${seenGlobalCap(env)}`;

/**
 * 记录一次「这个 IP 上出现了这个指纹」。
 * - 同日同指纹由主键去重；
 * - 同一 ip_hash 当天的新指纹达到上限（seenCap）后不再写入：先读当天行数，满额直接返回；
 *   写入语句本身也带条件（INSERT … SELECT … WHERE 当天行数 < 上限），并发请求也不会超出上限；
 * - 满额后记在本 isolate 的内存里，之后同 IP 当天的请求不再计数、不再写 D1，
 *   只按主键点查一次本指纹今天是否已计入（让满额前已计入的浏览器仍显示「已计入」）。
 * - 全站当天新增行数达到 seenGlobalCap 后暂停（paused）：计数器 seen_daily 与单 IP 计数在同一条查询里读出（1 次往返），
 *   写入（条件：计数器 < 上限）与计数器 +1（条件：确实写入了）在同一个 D1 batch / 事务里，并发也不会超额；
 *   暂停后本 isolate 记住，之后只做主键点查、不读计数器、不写。
 * - 条件写入没写进去时，先按主键确认本指纹是否已被并发的同一浏览器写入（→ 已计入，不记满额），
 *   只有本指纹确实不在、且上限确实已到时才算满额 / 暂停。
 * 返回 { inserted, capped, dup, paused }
 */
export async function recordSeen(env, parsed, fp, now = Date.now()) {
  const cap = seenCap(env);
  const day = dayStr(now);
  const ih = await ipHash(env, parsed);
  const memoKey = `${ih}|${day}`;
  const gcap = seenGlobalCap(env);
  const pausedKey = `${day}|${gcap}`;
  const fh = await fpHash(env, fp);
  const ipMemo = cappedMemo.get(memoKey) === cap;
  if (ipMemo || globalPaused === pausedKey) {
    const hit = await env.DB.prepare('SELECT 1 AS x FROM ip_seen WHERE ip_hash = ?1 AND fp_hash = ?2 AND day = ?3').bind(ih, fh, day).first();
    return { inserted: false, capped: ipMemo, dup: !!hit, paused: globalPaused === pausedKey, memo: true };
  }
  // 单 IP 当天行数、本指纹是否已计入（主键）、全站计数器：一次往返读出
  const STATE_SQL = 'SELECT COUNT(*) AS n, COUNT(CASE WHEN fp_hash = ?2 THEN 1 END) AS mine, (SELECT n FROM seen_daily WHERE day = ?3) AS g FROM ip_seen WHERE ip_hash = ?1 AND day = ?3';
  const row = await env.DB.prepare(STATE_SQL).bind(ih, fh, day).first();
  const n = Number(row?.n || 0);
  const g = Number(row?.g || 0);
  const paused = g >= gcap;
  if (paused) globalPaused = pausedKey;
  if (Number(row?.mine || 0) > 0) return { inserted: false, capped: n >= cap, dup: true, paused };
  if (paused) return { inserted: false, capped: n >= cap, dup: false, paused: true };
  if (n >= cap) { remember(memoKey, cap); return { inserted: false, capped: true, dup: false, paused: false }; }
  // 写入与计数器 +1 放在同一个 batch（D1 batch = 一个事务，按顺序执行）：
  // ① 条件写入：单 IP 当天行数 < 上限 且 全站计数器 < 全站上限；
  // ② 只有 ① 真的写入了一行（changes() > 0）才把计数器 +1。
  // 两条语句之间不会插入其它请求的语句，所以并发时「计数器 = 当天实际行数 ≤ 上限」。
  const ins = env.DB.prepare(
    'INSERT OR IGNORE INTO ip_seen (ip_hash, fp_hash, day) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM ip_seen WHERE ip_hash = ?1 AND day = ?3) < ?4'
    + ' AND COALESCE((SELECT n FROM seen_daily WHERE day = ?3), 0) < ?5',
  ).bind(ih, fh, day, cap, gcap);
  const inc = env.DB.prepare('INSERT INTO seen_daily (day, n) SELECT ?1, 1 WHERE changes() > 0 ON CONFLICT (day) DO UPDATE SET n = n + 1').bind(day);
  const [r] = await env.DB.batch([ins, inc]);
  const inserted = (r?.meta?.changes ?? 0) > 0;
  if (inserted) {
    if (g + 1 >= gcap) globalPaused = pausedKey;
    const capped = n + 1 >= cap;
    if (capped) remember(memoKey, cap);
    return { inserted: true, capped, dup: false, paused: false };
  }
  // 没写进去有三种可能，重新读一次状态区分（不能直接当成「满额」）：
  // ① 同一浏览器的另一个请求（如两个标签页）刚写入了同一主键 → INSERT OR IGNORE 忽略。这是「已计入」，
  //    不记满额、不暂停，否则这个 IP 当天的新设备都会被挡掉；
  // ② 全站计数器已达上限 → 暂停；③ 单 IP 行数已达上限 → 满额（记入内存）。
  // 三者都不是（理论上只有跨日等极端时序）→ 只返回「未写入」，不记任何状态，下次请求重新判断。
  const row2 = await env.DB.prepare(STATE_SQL).bind(ih, fh, day).first();
  const n2 = Number(row2?.n || 0);
  const g2 = Number(row2?.g || 0);
  if (Number(row2?.mine || 0) > 0) return { inserted: false, capped: n2 >= cap, dup: true, paused: g2 >= gcap };
  if (g2 >= gcap) { globalPaused = pausedKey; return { inserted: false, capped: n2 >= cap, dup: false, paused: true }; }
  if (n2 >= cap) { remember(memoKey, cap); return { inserted: false, capped: true, dup: false, paused: false }; }
  return { inserted: false, capped: false, dup: false, paused: false };
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
  const cutoff = dayStr(now, SEEN_WINDOW_DAYS - 1);
  const r = await env.DB.prepare('DELETE FROM ip_seen WHERE day < ?1').bind(cutoff).run();
  await env.DB.prepare('DELETE FROM seen_daily WHERE day < ?1').bind(cutoff).run().catch(() => {});
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
