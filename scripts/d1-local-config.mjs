#!/usr/bin/env node
// 生成 wrangler.local-d1.toml：内容与 wrangler.toml 相同，只是把注释掉的 D1 块打开（database_id 用本地占位 UUID）。
// 仅供 `wrangler dev --local` / `d1 migrations apply --local` 使用；该文件已加入 .gitignore，不要拿它部署。
import { readFileSync, writeFileSync } from 'node:fs';

const LOCAL_ID = '00000000-0000-0000-0000-000000000000';
const src = new URL('../wrangler.toml', import.meta.url);
const out = new URL('../wrangler.local-d1.toml', import.meta.url);
const lines = readFileSync(src, 'utf8').split('\n');
const a = lines.findIndex((l) => l.startsWith('# >>> D1 BEGIN'));
const b = lines.findIndex((l) => l.startsWith('# <<< D1 END'));
if (a < 0 || b < a) { console.error('wrangler.toml 中找不到 "# >>> D1 BEGIN" / "# <<< D1 END" 标记'); process.exit(1); }
const block = lines.slice(a + 1, b);
if (block.some((l) => l.trim() && !l.startsWith('# '))) {
  console.log('wrangler.toml 中的 D1 块已经启用，直接用 wrangler.toml 即可；仍生成一份副本。');
}
const enabled = block.map((l) => l.replace(/^# /, '')).map((l) => (l.startsWith('database_id') ? `database_id = "${LOCAL_ID}"   # 仅本地` : l));
const body = [
  '# 自动生成（scripts/d1-local-config.mjs），请勿编辑、请勿用于部署。',
  ...lines.slice(0, a), ...enabled, ...lines.slice(b + 1),
].join('\n');
writeFileSync(out, body);
console.log('已生成 wrangler.local-d1.toml（本地 D1 已启用）');
