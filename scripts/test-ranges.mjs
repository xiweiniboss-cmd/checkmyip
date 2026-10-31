#!/usr/bin/env node
// 云厂商 IP 段匹配测试：用原始 CIDR（cloud-ranges.json）做暴力匹配，与运行时索引（cloud-index.json）逐一对比。
import { readFileSync } from 'node:fs';
import { lookupIds, matchCloud } from '../src/lib/ranges.js';
import { parseIP, cidrRange, formatV4, formatV6 } from '../src/lib/ip.js';

const raw = JSON.parse(readFileSync(new URL('../src/data/cloud-ranges.json', import.meta.url)));
const all = { 4: [], 6: [] };
for (const [id, p] of Object.entries(raw.providers)) {
  for (const c of p.v4) { const r = cidrRange(c); all[4].push({ id, c, s: BigInt(r.s), e: BigInt(r.e), len: +c.split('/')[1] }); }
  for (const c of p.v6) { const r = cidrRange(c); all[6].push({ id, c, s: r.s, e: r.e, len: +c.split('/')[1] }); }
}
let fails = 0, checks = 0;
const fail = (m) => { if (fails++ < 20) console.error('✘', m); };
const randBig = (bits) => { let n = 0n; for (let i = 0; i < bits; i += 30) n = (n << 30n) | BigInt(Math.floor(Math.random() * 2 ** 30)); return n & ((1n << BigInt(bits)) - 1n); };
const toIp = (v, n) => (v === 4 ? formatV4(Number(n)) : formatV6(n));
const brute = (v, n) => [...new Set(all[v].filter((r) => r.s <= n && n <= r.e).map((r) => r.id))].sort();
function check(v, n, why) {
  checks++;
  const p = parseIP(toIp(v, n));
  const got = [...lookupIds(p)].sort(), exp = brute(v, n);
  if (got.join() !== exp.join()) fail(`${why}: ${p.ip} 期望 [${exp}] 实际 [${got}]`);
}

// 1. 指定样例（旧实现的漏检点）
const must = [['34.190.0.1', 'google'], ['34.128.0.1', 'google'], ['34.191.255.254', 'google']];
for (const [ip, id] of must) {
  checks++;
  const ids = lookupIds(parseIP(ip));
  if (!ids.includes(id)) fail(`${ip} 应命中 ${id}，实际 [${ids}]`);
  else console.log(`✔ ${ip} → [${ids}]  matchCloud: ${matchCloud(parseIP(ip)).map((x) => x.name).join('、')}`);
}
// 2. 每个 CIDR 的首、尾地址；大段（v4 ≤ /16、v6 ≤ /40）额外随机抽 64 个
for (const v of [4, 6]) {
  const bits = v === 4 ? 32 : 128;
  for (const r of all[v]) {
    check(v, r.s, `${r.id} ${r.c} 首地址`); check(v, r.e, `${r.id} ${r.c} 尾地址`);
    const big = v === 4 ? r.len <= 16 : r.len <= 40;
    for (let k = 0; k < (big ? 64 : 1); k++) check(v, r.s + (randBig(bits - r.len) % (r.e - r.s + 1n)), `${r.id} ${r.c} 随机`);
    if (r.s > 0n) check(v, r.s - 1n, `${r.id} ${r.c} 前一个地址`);
  }
}
// 3. 全地址空间随机抽样
for (let k = 0; k < 20000; k++) check(4, randBig(32), '随机 v4');
for (let k = 0; k < 5000; k++) check(6, (0x2n << 124n) | randBig(124), '随机 v6');
// 4. 家宽地址不应命中
for (const ip of ['114.222.1.1', '73.0.0.1', '117.136.0.1', '221.218.0.1']) { checks++; if (lookupIds(parseIP(ip)).length) fail(`${ip} 不应命中`); }

console.log(`${fails ? '✘' : '✔'} 共 ${checks} 次检查，失败 ${fails} 次`);
process.exit(fails ? 1 : 0);
