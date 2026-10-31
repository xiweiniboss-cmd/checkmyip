// 云厂商公开 IP 段匹配。
// 数据由 scripts/build-data.mjs 预先处理为「已排序、互不相交」的区间（src/data/cloud-index.json），
// 运行时不做任何排序或构建：IPv4 直接对数字数组二分；IPv6 对定宽十六进制字符串二分（字典序即数值序）。
import idx from '../data/cloud-index.json' with { type: 'json' };

/** 返回最后一个 starts[i] <= x 的下标，没有则 -1 */
function upper(starts, x) {
  let lo = 0, hi = starts.length - 1, pos = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= x) { pos = mid; lo = mid + 1; } else hi = mid - 1; }
  return pos;
}

export function lookupIds(p) {
  if (p.version === 4) {
    const t = idx.v4, i = upper(t.s, p.v4);
    return i >= 0 && p.v4 <= t.e[i] ? idx.labels[t.l[i]] : [];
  }
  // IPv6：只在查询 IPv6 时才把 BigInt 转成十六进制键，不构建任何结构
  const t = idx.v6;
  const key = p.v6.toString(16).padStart(32, '0').slice(0, t.width);
  const i = upper(t.s, key);
  return i >= 0 && key <= t.e[i] ? idx.labels[t.l[i]] : [];
}

/** 返回命中的厂商列表 [{id, name}] */
export function matchCloud(p) {
  const ids = lookupIds(p);
  // 同时命中 google 与 gcp 时，优先展示更具体的 gcp
  const list = ids.includes('gcp') ? ids.filter((x) => x !== 'google') : ids;
  return list.map((id) => ({ id, name: idx.providers[id] }));
}
