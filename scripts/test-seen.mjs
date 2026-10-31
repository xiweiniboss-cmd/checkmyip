#!/usr/bin/env node
// D1 计数测试：用 Node 自带的 SQLite（node:sqlite）模拟 D1 的 prepare/bind/run/first 接口，
// 直接执行 migrations/ 里的真实建表语句，验证去重、7/30 天计数、清理以及“不存原始数据”。
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseIP } from '../src/lib/ip.js';
import { seenStatus, recordSeen, countSeen, cleanupSeen, validFp, dayStr } from '../src/lib/seen.js';
let fails = 0, n = 0;
const eq = (name, got, exp) => { n++; if (JSON.stringify(got) !== JSON.stringify(exp)) { fails++; console.error(`✘ ${name}: 期望 ${JSON.stringify(exp)} 实际 ${JSON.stringify(got)}`); } };

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  return {
    raw: db,
    prepare(sql) {
      const st = db.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async run() { const r = st.run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
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

console.log(`${fails ? '✘' : '✔'} D1 计数测试 ${n} 项，失败 ${fails} 项`);
process.exit(fails ? 1 : 0);
