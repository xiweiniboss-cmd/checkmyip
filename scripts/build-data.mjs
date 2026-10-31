#!/usr/bin/env node
// 下载各云厂商公开的 IP 段与 Tor 出口节点列表，生成紧凑的 src/data/*.json。
// 用法：node scripts/build-data.mjs
// 任一来源失败不会中断，会保留上一次生成的数据（如果有）并在 meta.json 中记录。
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data');
const TIMEOUT = 30000;

async function get(url, type = 'text') {
  const ctl = AbortSignal.timeout(TIMEOUT);
  const r = await fetch(url, { signal: ctl, headers: { 'user-agent': 'checkmyip-build-data/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return type === 'json' ? r.json() : r.text();
}

const lines = (t) => t.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
const firstCol = (t) => lines(t).map((l) => l.split(',')[0].trim());

// 每个来源返回 CIDR 字符串数组（IPv4 / IPv6 混合）
const SOURCES = [
  { id: 'aws', name: 'Amazon AWS', url: 'https://ip-ranges.amazonaws.com/ip-ranges.json',
    parse: async (u) => { const j = await get(u, 'json'); return [...j.prefixes.map((p) => p.ip_prefix), ...j.ipv6_prefixes.map((p) => p.ipv6_prefix)]; } },
  { id: 'gcp', name: 'Google Cloud', url: 'https://www.gstatic.com/ipranges/cloud.json',
    parse: async (u) => { const j = await get(u, 'json'); return j.prefixes.map((p) => p.ipv4Prefix || p.ipv6Prefix).filter(Boolean); } },
  { id: 'google', name: 'Google', url: 'https://www.gstatic.com/ipranges/goog.json',
    parse: async (u) => { const j = await get(u, 'json'); return j.prefixes.map((p) => p.ipv4Prefix || p.ipv6Prefix).filter(Boolean); } },
  { id: 'cloudflare', name: 'Cloudflare', url: 'https://www.cloudflare.com/ips-v4',
    parse: async () => [...lines(await get('https://www.cloudflare.com/ips-v4')), ...lines(await get('https://www.cloudflare.com/ips-v6'))] },
  { id: 'azure', name: 'Microsoft Azure', url: 'https://www.microsoft.com/en-us/download/details.aspx?id=56519',
    parse: async (u) => {
      const page = await get(u);
      const m = page.match(/https:\/\/download\.microsoft\.com\/[^"']*ServiceTags_Public[^"']*\.json/);
      if (!m) throw new Error('未在下载页找到 ServiceTags JSON 链接');
      const j = await get(m[0], 'json');
      const tag = j.values.find((v) => v.name === 'AzureCloud');
      return tag.properties.addressPrefixes;
    } },
  { id: 'oracle', name: 'Oracle Cloud', url: 'https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json',
    parse: async (u) => { const j = await get(u, 'json'); return j.regions.flatMap((r) => r.cidrs.map((c) => c.cidr)); } },
  { id: 'digitalocean', name: 'DigitalOcean', url: 'https://www.digitalocean.com/geo/google.csv',
    parse: async (u) => firstCol(await get(u)) },
  { id: 'linode', name: 'Linode / Akamai', url: 'https://geoip.linode.com/',
    parse: async (u) => firstCol(await get(u)) },
  { id: 'vultr', name: 'Vultr', url: 'https://geofeed.constant.com/?text',
    parse: async (u) => firstCol(await get(u)) },
  { id: 'fastly', name: 'Fastly', url: 'https://api.fastly.com/public-ip-list',
    parse: async (u) => { const j = await get(u, 'json'); return [...j.addresses, ...(j.ipv6_addresses || [])]; } },
];

// ---------- CIDR 工具 ----------
function v4ToInt(s) {
  const p = s.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function v6ToBig(s) {
  if (s.includes('.')) { // 内嵌 IPv4
    const i = s.lastIndexOf(':'); const v4 = v4ToInt(s.slice(i + 1)); if (v4 == null) return null;
    s = s.slice(0, i + 1) + ((v4 >>> 16).toString(16)) + ':' + ((v4 & 0xffff).toString(16));
  }
  const [h, t] = s.split('::');
  const hp = h ? h.split(':') : []; const tp = t !== undefined && t ? t.split(':') : [];
  const fill = s.includes('::') ? 8 - hp.length - tp.length : 0;
  const parts = [...hp, ...Array(fill).fill('0'), ...tp];
  if (parts.length !== 8) return null;
  let n = 0n; for (const x of parts) n = (n << 16n) + BigInt(parseInt(x || '0', 16));
  return n;
}
const intToV4 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
function bigToV6(n) {
  const parts = []; for (let i = 0; i < 8; i++) { parts.unshift((n & 0xffffn).toString(16)); n >>= 16n; }
  return parts.join(':').replace(/(^|:)0(:0)+(:|$)/, '::').replace(/:{3,}/, '::');
}

// 合并为区间后再拆回最少的 CIDR，节省体积
function mergeRanges(ranges) {
  ranges.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1n) { if (r[1] > last[1]) last[1] = r[1]; } else out.push([r[0], r[1]]);
  }
  return out;
}
function rangeToCidrs(start, end, bits) {
  const res = [];
  while (start <= end) {
    let size = 0n;
    while (size < BigInt(bits)) {
      const blk = 1n << (size + 1n);
      if (start % blk !== 0n || start + blk - 1n > end) break;
      size++;
    }
    res.push([start, bits - Number(size)]);
    start += 1n << size;
  }
  return res;
}
function compact(cidrs) {
  const v4 = [], v6 = []; let bad = 0;
  for (const c of cidrs) {
    const [addr, lenS] = c.split('/'); const len = Number(lenS ?? (addr.includes(':') ? 128 : 32));
    if (addr.includes(':')) {
      const n = v6ToBig(addr); if (n == null || !(len >= 0 && len <= 128)) { bad++; continue; }
      const host = (1n << BigInt(128 - len)) - 1n; const s = n & ~host & ((1n << 128n) - 1n); v6.push([s, s + host]);
    } else {
      const n = v4ToInt(addr); if (n == null || !(len >= 0 && len <= 32)) { bad++; continue; }
      const host = (1n << BigInt(32 - len)) - 1n; const s = BigInt(n) & ~host & 0xffffffffn; v4.push([s, s + host]);
    }
  }
  const o4 = mergeRanges(v4).flatMap(([s, e]) => rangeToCidrs(s, e, 32)).map(([s, l]) => `${intToV4(Number(s))}/${l}`);
  const o6 = mergeRanges(v6).flatMap(([s, e]) => rangeToCidrs(s, e, 128)).map(([s, l]) => `${bigToV6(s)}/${l}`);
  return { v4: o4, v6: o6, bad };
}

async function readOld(file) { try { return JSON.parse(await readFile(path.join(DATA_DIR, file), 'utf8')); } catch { return null; } }

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const old = (await readOld('cloud-ranges.json')) || { providers: {} };
  const providers = {}; const meta = { generatedAt: new Date().toISOString(), sources: {} };
  for (const s of SOURCES) {
    try {
      const raw = await s.parse(s.url);
      const c = compact(raw);
      providers[s.id] = { name: s.name, v4: c.v4, v6: c.v6 };
      meta.sources[s.id] = { ok: true, url: s.url, input: raw.length, v4: c.v4.length, v6: c.v6.length, invalid: c.bad };
      console.log(`✔ ${s.id.padEnd(13)} 输入 ${raw.length} 条 → v4 ${c.v4.length} / v6 ${c.v6.length}`);
    } catch (e) {
      meta.sources[s.id] = { ok: false, url: s.url, error: String(e.message || e), keptOld: !!old.providers[s.id] };
      if (old.providers[s.id]) providers[s.id] = old.providers[s.id];
      console.warn(`✘ ${s.id.padEnd(13)} 失败：${e.message || e}${old.providers[s.id] ? '（保留旧数据）' : ''}`);
    }
  }
  await writeFile(path.join(DATA_DIR, 'cloud-ranges.json'), JSON.stringify({ providers }));

  // Tor 出口节点
  try {
    const ips = lines(await get('https://check.torproject.org/torbulkexitlist')).filter((l) => /^[0-9a-f.:]+$/i.test(l));
    await writeFile(path.join(DATA_DIR, 'tor-exits.json'), JSON.stringify({ updatedAt: meta.generatedAt, ips }));
    meta.sources.tor = { ok: true, url: 'https://check.torproject.org/torbulkexitlist', count: ips.length };
    console.log(`✔ tor           出口节点 ${ips.length} 个`);
  } catch (e) {
    meta.sources.tor = { ok: false, error: String(e.message || e) };
    console.warn(`✘ tor 失败：${e.message || e}`);
  }
  await writeFile(path.join(DATA_DIR, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
}
main().catch((e) => { console.error(e); process.exit(1); });
