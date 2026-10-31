#!/usr/bin/env node
// 全站每日上限的并发压测：用 wrangler getPlatformProxy 拿到「本地 D1」（workerd / miniflare 的真实 SQLite），
// 对 recordSeen 同时发起 N 个请求（每个请求不同 IP、不同指纹），检查 ip_seen 当天行数与计数器都不超过上限。
// 第二部分（v0.3.4）：同一浏览器并发上报两次（两个标签页）不能被当成满额：M 个 IP 各自用同一指纹并发上报两次，
// 之后每个 IP 再报一个新指纹，检查每个 IP 恰好 2 行、一半请求为「已计入」、没有任何满额。
// 用法：npm run stress:seen（会先生成 wrangler.local-d1.toml）；或 node scripts/stress-seen-d1.mjs [N=1000] [cap=50] [M=200]
// 使用独立的临时持久化目录，不影响 .wrangler/state 里的开发数据。
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import { parseIP } from '../src/lib/ip.js';
import { recordSeen, dayStr, _resetCappedMemo } from '../src/lib/seen.js';

const N = Number(process.argv[2] || 1000), CAP = Number(process.argv[3] || 50), M = Number(process.argv[4] || 200);
const persist = `/tmp/cmi-stress-${process.pid}`;
const proxy = await getPlatformProxy({ configPath: 'wrangler.local-d1.toml', persist: { path: persist } });
try {
  const DB = proxy.env.DB;
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = readFileSync(new URL(f, dir), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) await DB.prepare(stmt).run();
  }
  const env = { DB, IP_HASH_SALT: 'stress-salt-0123456789abcdef', SEEN_GLOBAL_DAILY_CAP: String(CAP) };
  _resetCappedMemo();
  const now = Date.now();
  const ip = (i) => parseIP(`100.${64 + ((i >> 16) & 63)}.${(i >> 8) & 255}.${i & 255}`.replace(/^100\.(\d+)/, (m, a) => `11.${a}`));
  const t0 = Date.now();
  const res = await Promise.allSettled(Array.from({ length: N }, (_, i) => recordSeen(env, ip(i), (0x10000000 + i).toString(16).padStart(16, '0'), now)));
  const ok = res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const errs = res.filter((r) => r.status === 'rejected');
  const rows = (await DB.prepare('SELECT COUNT(*) AS c FROM ip_seen WHERE day = ?1').bind(dayStr(now)).first()).c;
  const counter = (await DB.prepare('SELECT n FROM seen_daily WHERE day = ?1').bind(dayStr(now)).first())?.n ?? 0;
  const summary = { concurrent: N, cap: CAP, inserted: ok.filter((r) => r.inserted).length, paused: ok.filter((r) => r.paused).length,
    errors: errs.length, firstError: errs[0] ? String(errs[0].reason) : null, rowsToday: rows, counterToday: counter, ms: Date.now() - t0 };
  console.log(JSON.stringify(summary));
  const pass = rows <= CAP && counter === rows && !errs.length;
  console.log(`${pass ? '✔' : '✘'} ip_seen 当天 ${rows} 行（上限 ${CAP}），计数器 ${counter}`);

  // 第二部分：同指纹并发重复上报（全站上限放大，避免受第一部分影响）
  _resetCappedMemo();
  const env2 = { DB, IP_HASH_SALT: 'stress-salt-0123456789abcdef', SEEN_GLOBAL_DAILY_CAP: '10000000' };
  const ip2 = (i) => parseIP(`198.18.${(i >> 8) & 255}.${i & 255}`);
  const fpA = (i) => (0x20000000 + i).toString(16).padStart(16, '0'), fpB = (i) => (0x30000000 + i).toString(16).padStart(16, '0');
  const t1 = Date.now();
  const dupRes = await Promise.allSettled(Array.from({ length: M * 2 }, (_, k) => recordSeen(env2, ip2(k >> 1), fpA(k >> 1), now)));
  const nextRes = await Promise.allSettled(Array.from({ length: M }, (_, i) => recordSeen(env2, ip2(i), fpB(i), now)));
  const d = dupRes.filter((r) => r.status === 'fulfilled').map((r) => r.value), nx = nextRes.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const errs2 = [...dupRes, ...nextRes].filter((r) => r.status === 'rejected');
  const rows2 = (await DB.prepare('SELECT COUNT(*) AS c FROM ip_seen WHERE day = ?1').bind(dayStr(now)).first()).c - rows;
  const counter2 = (await DB.prepare('SELECT n FROM seen_daily WHERE day = ?1').bind(dayStr(now)).first())?.n - counter;
  const s2 = { ips: M, dupRequests: M * 2, dupInserted: d.filter((r) => r.inserted).length, dupAlreadyCounted: d.filter((r) => r.dup).length,
    dupCapped: d.filter((r) => r.capped).length, nextInserted: nx.filter((r) => r.inserted).length, nextCapped: nx.filter((r) => r.capped).length,
    errors: errs2.length, firstError: errs2[0] ? String(errs2[0].reason) : null, newRows: rows2, counterDelta: counter2, ms: Date.now() - t1 };
  console.log(JSON.stringify(s2));
  const pass2 = s2.dupInserted === M && s2.dupAlreadyCounted === M && s2.dupCapped === 0 && s2.nextInserted === M && s2.nextCapped === 0
    && rows2 === 2 * M && counter2 === rows2 && !errs2.length;
  console.log(`${pass2 ? '✔' : '✘'} 同指纹并发重复：${M} 个 IP 各 2 次 → 写入 ${s2.dupInserted}、已计入 ${s2.dupAlreadyCounted}、满额 ${s2.dupCapped}；之后新指纹写入 ${s2.nextInserted}/${M}`);
  process.exitCode = pass && pass2 ? 0 : 1;
} finally {
  await proxy.dispose();
  rmSync(persist, { recursive: true, force: true });
}
