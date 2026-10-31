// 云厂商公开 IP 段匹配。数据由 scripts/build-data.mjs 生成。
import data from '../data/cloud-ranges.json';
import { cidrRange } from './ip.js';

let index = null;

function build() {
  const v4 = [], v6 = [];
  for (const [id, p] of Object.entries(data.providers)) {
    for (const c of p.v4) { const r = cidrRange(c); v4.push([r.s, r.e, id]); }
    for (const c of p.v6) { const r = cidrRange(c); v6.push([r.s, r.e, id]); }
  }
  const cmp = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  v4.sort(cmp); v6.sort(cmp);
  index = { v4, v6 };
}

// 区间可能在不同厂商间重叠（如 google 与 gcp），所以向前扫描若干条
function search(list, n) {
  let lo = 0, hi = list.length - 1, pos = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid][0] <= n) { pos = mid; lo = mid + 1; } else hi = mid - 1; }
  const hits = [];
  for (let i = pos; i >= 0 && i > pos - 64; i--) if (n <= list[i][1]) hits.push(list[i][2]);
  return [...new Set(hits)];
}

/** 返回命中的厂商列表 [{id, name}] */
export function matchCloud(p) {
  if (!index) build();
  const ids = p.version === 4 ? search(index.v4, p.v4) : search(index.v6, p.v6);
  // 同时命中 google 与 gcp 时，优先展示更具体的 gcp
  const list = ids.includes('gcp') ? ids.filter((x) => x !== 'google') : ids;
  return list.map((id) => ({ id, name: data.providers[id].name }));
}
