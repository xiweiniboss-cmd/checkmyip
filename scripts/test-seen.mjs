#!/usr/bin/env node
// D1 计数测试：用 Node 自带的 SQLite（node:sqlite）模拟 D1 的 prepare/bind/run/first 接口，
// 直接执行 migrations/ 里的真实建表语句，验证去重、7/30 天计数、清理以及“不存原始数据”。
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseIP } from '../src/lib/ip.js';
import { seenStatus, seenCap, recordSeen, countSeen, cleanupSeen, validFp, dayStr, ipKey, SEEN_DAILY_CAP_DEFAULT, _resetCappedMemo, seenGlobalCap, SEEN_GLOBAL_DAILY_CAP_DEFAULT, globalPausedToday } from '../src/lib/seen.js';
import { limiterKey } from '../src/lib/ratelimit.js';
let fails = 0, n = 0;
const eq = (name, got, exp) => { n++; if (JSON.stringify(got) !== JSON.stringify(exp)) { fails++; console.error(`✘ ${name}: 期望 ${JSON.stringify(exp)} 实际 ${JSON.stringify(got)}`); } };

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const stats = { prepares: 0, writes: 0, rowsWritten: 0 };
  return {
    raw: db, stats,
    prepare(sql) {
      stats.prepares++;
      const st = db.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async run() { const r = st.run(...args); stats.writes++; stats.rowsWritten += Number(r.changes); return { success: true, meta: { changes: Number(r.changes) } }; },
        async first() { return st.get(...args) ?? null; },
      };
      return api;
    },
  };
}

const DB = fakeD1();
const env = { DB, IP_HASH_SALT: 'test-salt-0123456789abcdef' };
const now = Date.parse('2026-10-31T12:00:00Z');
const day = 86400_000;
const A = parseIP('114.222.1.1'), B = parseIP('117.136.0.1');
const fps = ['a1b2c3d4e5f60718', '0011223344556677', 'ffeeddccbbaa9988'];

eq('启用状态', seenStatus(env).enabled, true);
eq('无 DB → 未启用', seenStatus({ IP_HASH_SALT: env.IP_HASH_SALT }).reason, 'no_db');
eq('无盐 → 未启用（不做无盐哈希）', seenStatus({ DB }).reason, 'no_salt');
eq('fp 校验', [validFp(fps[0]), validFp('xyz'), validFp('abc'), validFp('a'.repeat(65)), validFp(123)], [true, false, false, false, false]);

// 同一 IP 上 3 个不同指纹；重复上报同一天只记一次
const ins = [];
for (const fp of fps) ins.push((await recordSeen(env, A, fp, now)).inserted);
ins.push((await recordSeen(env, A, fps[0], now)).inserted);
eq('插入与同日去重', ins, [true, true, true, false]);
eq('IP A：30 天 3、7 天 3', await countSeen(env, A, now), { devices30d: 3, devices7d: 3, scope: 'ip' });
eq('IP B 互不影响', (await countSeen(env, B, now)).devices30d, 0);
// 跨天：10 天前的第 4 个指纹只计入 30 天；同一指纹不同天只算一个设备
await recordSeen(env, A, 'deadbeefdeadbeef', now - 10 * day);
await recordSeen(env, A, fps[1], now - 3 * day);
eq('跨天计数', await countSeen(env, A, now), { devices30d: 4, devices7d: 3, scope: 'ip' });
// 40 天前的记录不计入，并会被清理
await recordSeen(env, A, '1234123412341234', now - 40 * day);
eq('超过 30 天不计入', (await countSeen(env, A, now)).devices30d, 4);
const before = DB.raw.prepare('SELECT COUNT(*) AS c FROM ip_seen').get().c;
const cl = await cleanupSeen(env, now);
const after = DB.raw.prepare('SELECT COUNT(*) AS c FROM ip_seen').get().c;
eq('清理 30 天前的数据', [cl.deleted, before - after, DB.raw.prepare('SELECT MIN(day) AS d FROM ip_seen').get().d >= dayStr(now, 29)], [1, 1, true]);
// IPv6 按 /64 聚合
const v6a = parseIP('2408:8000:1:2::a'), v6b = parseIP('2408:8000:1:2:ffff::b'), v6c = parseIP('2408:8000:1:3::a');
await recordSeen(env, v6a, fps[0], now); await recordSeen(env, v6b, fps[1], now); await recordSeen(env, v6c, fps[2], now);
eq('IPv6 同一 /64 合并', await countSeen(env, v6a, now), { devices30d: 2, devices7d: 2, scope: '/64' });
// 不存原始数据：库里只能出现固定长度的十六进制哈希，且不包含原始 IP / 指纹
const rows = DB.raw.prepare('SELECT ip_hash, fp_hash, day FROM ip_seen').all();
const dump = JSON.stringify(rows);
eq('只存哈希', [rows.every((r) => /^[0-9a-f]{32}$/.test(r.ip_hash) && /^[0-9a-f]{32}$/.test(r.fp_hash) && /^\d{4}-\d{2}-\d{2}$/.test(r.day)),
  [A.ip, B.ip, '2408:8000', ...fps].some((x) => dump.includes(x))], [true, false]);
// 换盐后哈希不同（无法跨部署关联）
const other = { DB: fakeD1(), IP_HASH_SALT: 'another-salt-abcdef0123456789' };
await recordSeen(other, A, fps[0], now);
const h1 = DB.raw.prepare('SELECT ip_hash FROM ip_seen LIMIT 1').get().ip_hash;
eq('不同盐 → 不同哈希', other.DB.raw.prepare('SELECT ip_hash FROM ip_seen').get().ip_hash !== h1, true);

// ---------- v0.3.1：每个 ip_hash 每天新指纹上限 ----------
_resetCappedMemo();
eq('默认上限 30', [SEEN_DAILY_CAP_DEFAULT, seenCap({}), seenCap({ SEEN_DAILY_CAP: '5' }), seenCap({ SEEN_DAILY_CAP: 'x' }), seenCap({ SEEN_DAILY_CAP: '0' })], [30, 30, 5, 30, 30]);
const capEnv = { DB: fakeD1(), IP_HASH_SALT: 'cap-salt-0123456789abcdef' };
const C = parseIP('198.51.100.23');
const fpN = (i) => i.toString(16).padStart(16, '0');
let capIns = 0, lastCapped = null;
for (let i = 0; i < 30; i++) { const r = await recordSeen(capEnv, C, fpN(i), now); if (r.inserted) capIns++; lastCapped = r.capped; }
eq('前 30 个指纹都写入，第 30 个时标记满额', [capIns, lastCapped], [30, true]);
const st0 = { ...capEnv.DB.stats };
const over = [];
for (let i = 30; i < 100; i++) over.push(await recordSeen(capEnv, C, fpN(i), now));
eq('满额后不再写 D1（写入 0 次 / 0 行），每次请求只做 1 次主键点查', [capEnv.DB.stats.writes - st0.writes, capEnv.DB.stats.rowsWritten - st0.rowsWritten, capEnv.DB.stats.prepares - st0.prepares], [0, 0, over.length]);
{
  const again = await recordSeen(capEnv, C, fpN(0), now);
  eq('满额后，早已计入的浏览器仍判为已计入（dup=true）', [again.inserted, again.capped, again.dup], [false, true, true]);
}
eq('超出上限的 70 个都不写入', [over.every((r) => !r.inserted && r.capped), (await countSeen(capEnv, C, now)).devices30d], [true, 30]);
// 新 isolate（内存记忆为空）：先读后判，同样不写
_resetCappedMemo();
const st1 = { ...capEnv.DB.stats };
const r31 = await recordSeen(capEnv, C, fpN(31), now);
eq('新 isolate：满额只读一次、不写', [r31.inserted, r31.capped, capEnv.DB.stats.writes - st1.writes, capEnv.DB.stats.prepares - st1.prepares], [false, true, 0, 1]);
// 已记录过的指纹再来：不新增
_resetCappedMemo();
eq('满额后已有指纹再来：不新增', (await recordSeen(capEnv, C, fpN(3), now)).inserted, false);
// 其它 IP 不受影响；第二天重新计数
eq('其它 IP 不受影响', (await recordSeen(capEnv, parseIP('198.51.100.24'), fpN(500), now)).inserted, true);
eq('次日重新计数', (await recordSeen(capEnv, C, fpN(999), now + day)).inserted, true);
// 条件写入：即使绕过预读（并发请求同时通过预读），也写不进第 31 行
_resetCappedMemo();
const capEnv2 = { DB: fakeD1(), IP_HASH_SALT: 'cap-salt-0123456789abcdef', SEEN_DAILY_CAP: '3' };
const D = parseIP('203.0.113.77');
const par = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => recordSeen(capEnv2, D, fpN(1000 + i), now)));
eq('并发 6 个、上限 3：只写入 3 个', [par.filter((r) => r.inserted).length, (await countSeen(capEnv2, D, now)).devices30d], [3, 3]);
// IPv6：同一 /64 下不同地址共享上限
_resetCappedMemo();
const capEnv3 = { DB: fakeD1(), IP_HASH_SALT: 'cap-salt-0123456789abcdef', SEEN_DAILY_CAP: '5' };
let v6ins = 0;
for (let i = 0; i < 20; i++) { const r = await recordSeen(capEnv3, parseIP(`2001:db8:aa:bb:${(i + 1).toString(16)}::1`), fpN(2000 + i), now); if (r.inserted) v6ins++; }
eq('IPv6 换地址（同一 /64）也共享上限', v6ins, 5);
// 计数与限流用的是同一个键
eq('ipKey 与限流键一致', [ipKey(parseIP('2001:db8:aa:bb::1')).key, limiterKey('2001:db8:aa:bb:ffff::9')], ['v6/64:20010db800aa00bb', 'v6/64:20010db800aa00bb']);

// v0.3.2：全站每日新增行上限（SEEN_GLOBAL_DAILY_CAP）
eq('全站上限默认 15000 / 可配置 / 非法值回落默认', [SEEN_GLOBAL_DAILY_CAP_DEFAULT, seenGlobalCap({}), seenGlobalCap({ SEEN_GLOBAL_DAILY_CAP: '50000' }), seenGlobalCap({ SEEN_GLOBAL_DAILY_CAP: 'x' }), seenGlobalCap({ SEEN_GLOBAL_DAILY_CAP: '0' }), seenGlobalCap({ SEEN_GLOBAL_DAILY_CAP: '1e9' })], [15000, 15000, 50000, 15000, 15000, 10000000]);
_resetCappedMemo();
const gEnv = { DB: fakeD1(), IP_HASH_SALT: 'glob-salt-0123456789abcdef', SEEN_GLOBAL_DAILY_CAP: '5' };
const gIps = Array.from({ length: 12 }, (_, i) => parseIP(`192.0.2.${i + 1}`));
const gRes = [];
for (let i = 0; i < 5; i++) gRes.push(await recordSeen(gEnv, gIps[i], fpN(3000 + i), now));
eq('全站上限 5：前 5 个不同 IP 都写入，第 5 个之后本 isolate 记为暂停', [gRes.every((r) => r.inserted && !r.paused), globalPausedToday(gEnv, now)], [true, true]);
eq('计数器 seen_daily 当天 = 5', gEnv.DB.raw.prepare('SELECT n FROM seen_daily WHERE day = ?').get(dayStr(now)).n, 5);
const gSt = { ...gEnv.DB.stats };
const gOver = [];
for (let i = 5; i < 12; i++) gOver.push(await recordSeen(gEnv, gIps[i], fpN(3000 + i), now));
eq('达到全站上限后：paused=true、不写入、0 次写、每请求只 1 次主键点查', [gOver.every((r) => r.paused && !r.inserted && !r.capped), gEnv.DB.stats.writes - gSt.writes, gEnv.DB.stats.prepares - gSt.prepares], [true, 0, gOver.length]);
eq('ip_seen 当天只有 5 行', gEnv.DB.raw.prepare('SELECT COUNT(*) AS c FROM ip_seen WHERE day = ?').get(dayStr(now)).c, 5);
{
  const again = await recordSeen(gEnv, gIps[0], fpN(3000), now);
  eq('暂停后，早已计入的浏览器仍判为已计入', [again.inserted, again.paused, again.dup], [false, true, true]);
}
// 新 isolate（内存为空）：读一次（含计数器）即知暂停，不写
_resetCappedMemo();
const gSt2 = { ...gEnv.DB.stats };
const gNew = await recordSeen(gEnv, gIps[11], fpN(3999), now);
eq('新 isolate：1 次读取即判定暂停、不写', [gNew.paused, gNew.inserted, gEnv.DB.stats.writes - gSt2.writes, gEnv.DB.stats.prepares - gSt2.prepares], [true, false, 0, 1]);
eq('暂停不影响读取计数（countSeen 照常）', (await countSeen(gEnv, gIps[0], now)).devices30d, 1);
// 次日自动恢复
eq('次日自动恢复写入', [(await recordSeen(gEnv, gIps[11], fpN(4000), now + day)).inserted, globalPausedToday(gEnv, now + day)], [true, false]);
// 并发：即使同时通过预读，条件写入也不超过全站上限
_resetCappedMemo();
const gEnv2 = { DB: fakeD1(), IP_HASH_SALT: 'glob-salt-0123456789abcdef', SEEN_GLOBAL_DAILY_CAP: '3' };
const gPar = await Promise.all(Array.from({ length: 8 }, (_, i) => recordSeen(gEnv2, parseIP(`198.18.0.${i + 1}`), fpN(5000 + i), now)));
eq('并发 8 个不同 IP、全站上限 3：只写入 3 行，其余 paused', [gPar.filter((r) => r.inserted).length, gPar.filter((r) => r.paused).length, gEnv2.DB.raw.prepare('SELECT COUNT(*) AS c FROM ip_seen').get().c], [3, 5, 3]);
// 清理同时删除 30 天前的计数器行
{
  const cEnv = { DB: fakeD1(), IP_HASH_SALT: 'glob-salt-0123456789abcdef' };
  await recordSeen(cEnv, gIps[0], fpN(1), now - 40 * day);
  _resetCappedMemo();
  await recordSeen(cEnv, gIps[0], fpN(2), now);
  await cleanupSeen(cEnv, now);
  eq('清理同时删除过期 seen_daily 行', cEnv.DB.raw.prepare('SELECT day FROM seen_daily ORDER BY day').all().map((x) => x.day), [dayStr(now)]);
}
_resetCappedMemo();

console.log(`${fails ? '✘' : '✔'} D1 计数测试 ${n} 项，失败 ${fails} 项`);
process.exit(fails ? 1 : 0);
