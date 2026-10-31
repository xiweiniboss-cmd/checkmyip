#!/usr/bin/env node
// 静态资源缓存刷新（cache-busting）：
// 对 public/assets/* 与 public/config.js 的内容计算 SHA-256，取前 10 位作为资源版本号，
// 把 index.html 里所有 /assets/… 与 /config.js 引用改写为 ?v=<版本号>，并写入 <meta name="checkmyip-asset-version">
// （app.js 动态生成的图标引用会读取它）。资源内容不变 → 版本号不变；任何资源改动 → 浏览器拿到新 URL。
//   node scripts/stamp-assets.mjs          改写 index.html
//   node scripts/stamp-assets.mjs --check  只检查（npm test 用），未更新时返回 1
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../public/', import.meta.url);
const files = [...readdirSync(new URL('assets/', root)).sort().map((f) => `assets/${f}`), 'config.js'];
const h = createHash('sha256');
for (const f of files) { h.update(f + '\0'); h.update(readFileSync(new URL(f, root))); h.update('\0'); }
const version = h.digest('hex').slice(0, 10);

const htmlUrl = new URL('index.html', root);
const html = readFileSync(htmlUrl, 'utf8');
let out = html.replace(/(["'(])(\/(?:assets\/[\w.-]+|config\.js))(?:\?v=[\w.-]*)?(?=[#"')])/g, (_, q, path) => `${q}${path}?v=${version}`);
const meta = `<meta name="checkmyip-asset-version" content="${version}">`;
out = /<meta name="checkmyip-asset-version" content="[^"]*">/.test(out)
  ? out.replace(/<meta name="checkmyip-asset-version" content="[^"]*">/, meta)
  : out.replace(/(<meta charset="utf-8">\n)/, `$1  ${meta}\n`);

if (process.argv.includes('--check')) {
  if (out !== html) { console.error(`✘ index.html 的资源版本号不是最新（应为 ${version}），请运行 npm run build:assets`); process.exit(1); }
  console.log(`✔ 资源版本号最新：${version}（${files.length} 个文件）`);
} else {
  if (out !== html) writeFileSync(htmlUrl, out);
  console.log(`资源版本号：${version}${out !== html ? '（已更新 index.html）' : '（无变化）'}`);
}
