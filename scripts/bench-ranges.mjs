#!/usr/bin/env node
// 冷启动 CPU 时间测量：每次用全新的 node 进程导入模块并做第一次查询。
// 用法：node scripts/bench-ranges.mjs [模块路径]  （默认 src/lib/ranges.js）
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const mod = process.argv[2] || fileURLToPath(new URL('../src/lib/ranges.js', import.meta.url));
const ipMod = fileURLToPath(new URL('../src/lib/ip.js', import.meta.url));
const child = `
const ip = await import(${JSON.stringify(ipMod)});
const q = process.argv[1]; const p = ip.parseIP(q);
const c0 = process.cpuUsage(); const t0 = performance.now();
const m = await import(${JSON.stringify(mod)});
const c1 = process.cpuUsage(); const t1 = performance.now();
const r = m.matchCloud(p);
const c2 = process.cpuUsage(); const t2 = performance.now();
const r2 = m.matchCloud(p); const t3 = performance.now();
const cpu = (a, b) => ((b.user - a.user) + (b.system - a.system)) / 1000;
console.log(JSON.stringify({ q, hit: r.map((x) => x.id).join('+') || '-', importCpu: cpu(c0, c1), importWall: t1 - t0, firstCpu: cpu(c1, c2), firstWall: t2 - t1, warmWall: t3 - t2 }));
`;
const rows = [];
for (const q of ['34.190.0.1', '114.222.1.1', '2600:1f00::1', '2001:4860:4860::8888']) {
  const runs = [];
  for (let i = 0; i < 7; i++) runs.push(JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e', child, q], { encoding: 'utf8' }).stdout));
  const med = (k) => runs.map((r) => r[k]).sort((a, b) => a - b)[3];
  rows.push({ q, hit: runs[0].hit, importCpu: med('importCpu'), importWall: med('importWall'), firstCpu: med('firstCpu'), firstWall: med('firstWall'), warmWall: med('warmWall') });
}
console.log('| 查询 | 命中 | 导入模块 CPU ms | 首次查询 CPU ms | 首次查询 wall ms | 第二次查询 wall ms |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.q} | ${r.hit} | ${r.importCpu.toFixed(2)} | ${r.firstCpu.toFixed(2)} | ${r.firstWall.toFixed(3)} | ${r.warmWall.toFixed(4)} |`);
