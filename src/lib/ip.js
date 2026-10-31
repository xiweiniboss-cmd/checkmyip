// IP 地址解析与 CIDR 工具（IPv4 用 number，IPv6 用 BigInt）

export function parseV4(s) {
  if (typeof s !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  const p = s.split('.').map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

export function parseV6(s) {
  if (typeof s !== 'string' || !s.includes(':') || !/^[0-9a-fA-F:.]+$/.test(s)) return null;
  if ((s.match(/::/g) || []).length > 1) return null;
  if (s.includes('.')) {
    const i = s.lastIndexOf(':');
    const v4 = parseV4(s.slice(i + 1));
    if (v4 == null) return null;
    s = s.slice(0, i + 1) + (v4 >>> 16).toString(16) + ':' + (v4 & 0xffff).toString(16);
  }
  const [h, t] = s.split('::');
  const hp = h ? h.split(':') : [];
  const tp = t ? t.split(':') : [];
  const has = s.includes('::');
  const fill = has ? 8 - hp.length - tp.length : 0;
  if (fill < 0 || (has && fill < 1 && false)) return null;
  const parts = [...hp, ...Array(fill).fill('0'), ...tp];
  if (parts.length !== 8 || parts.some((x) => !/^[0-9a-fA-F]{1,4}$/.test(x))) return null;
  let n = 0n;
  for (const x of parts) n = (n << 16n) + BigInt(parseInt(x, 16));
  return n;
}

/** 解析任意 IP，返回 { ip(规范化), version, v4?, v6? } 或 null */
export function parseIP(input) {
  if (!input) return null;
  let s = String(input).trim().replace(/^\[|\]$/g, '');
  if (s.includes('%')) s = s.split('%')[0];
  const v4 = parseV4(s);
  if (v4 != null) return { ip: formatV4(v4), version: 4, v4 };
  const v6 = parseV6(s);
  if (v6 != null) {
    // IPv4 映射地址 ::ffff:a.b.c.d 视为 IPv4
    if (v6 >> 32n === 0xffffn) { const n = Number(v6 & 0xffffffffn); return { ip: formatV4(n), version: 4, v4: n }; }
    return { ip: formatV6(v6), version: 6, v6 };
  }
  return null;
}

export const formatV4 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

export function formatV6(n) {
  const parts = [];
  for (let i = 0; i < 8; i++) { parts.unshift(Number(n & 0xffffn)); n >>= 16n; }
  // 找最长的连续 0 段压缩为 ::
  let bs = -1, bl = 0;
  for (let i = 0; i < 8;) {
    if (parts[i] === 0) { let j = i; while (j < 8 && parts[j] === 0) j++; if (j - i > bl && j - i > 1) { bs = i; bl = j - i; } i = j; } else i++;
  }
  const hex = parts.map((x) => x.toString(16));
  if (bs < 0) return hex.join(':');
  return hex.slice(0, bs).join(':') + '::' + hex.slice(bs + bl).join(':');
}

/** 把 CIDR 字符串转为 [start, end]（v4 为 number，v6 为 BigInt） */
export function cidrRange(cidr) {
  const [addr, lenS] = cidr.split('/');
  const len = Number(lenS);
  if (addr.includes(':')) {
    const n = parseV6(addr);
    const host = (1n << BigInt(128 - len)) - 1n;
    const s = n & ~host & ((1n << 128n) - 1n);
    return { v: 6, s, e: s + host };
  }
  const n = parseV4(addr);
  const size = 2 ** (32 - len);
  const s = n - (n % size);
  return { v: 4, s, e: s + size - 1 };
}

// 保留 / 私有地址
const BOGON_V4 = [
  ['0.0.0.0/8', '本网络'], ['10.0.0.0/8', '私有地址'], ['100.64.0.0/10', '运营商级 NAT (CGNAT)'],
  ['127.0.0.0/8', '回环地址'], ['169.254.0.0/16', '链路本地'], ['172.16.0.0/12', '私有地址'],
  ['192.0.0.0/24', 'IETF 保留'], ['192.0.2.0/24', '文档示例'], ['192.168.0.0/16', '私有地址'],
  ['198.18.0.0/15', '基准测试'], ['198.51.100.0/24', '文档示例'], ['203.0.113.0/24', '文档示例'],
  ['224.0.0.0/4', '组播地址'], ['240.0.0.0/4', '保留地址'],
].map(([c, n]) => ({ ...cidrRange(c), name: n }));
const BOGON_V6 = [
  ['::/128', '未指定地址'], ['::1/128', '回环地址'], ['fc00::/7', '唯一本地地址 (ULA)'],
  ['fe80::/10', '链路本地'], ['ff00::/8', '组播地址'], ['2001:db8::/32', '文档示例'], ['64:ff9b::/96', 'NAT64'],
].map(([c, n]) => ({ ...cidrRange(c), name: n }));

/** 若为私有/保留地址返回说明，否则 null */
export function bogonReason(p) {
  if (p.version === 4) { for (const b of BOGON_V4) if (p.v4 >= b.s && p.v4 <= b.e) return b.name; return null; }
  for (const b of BOGON_V6) if (p.v6 >= b.s && p.v6 <= b.e) return b.name;
  if (p.v6 >> 125n !== 1n) return '非全球单播地址';
  return null;
}

/** 反向解析用的 in-addr.arpa / ip6.arpa 名称 */
export function ptrName(p) {
  if (p.version === 4) return p.ip.split('.').reverse().join('.') + '.in-addr.arpa';
  return p.v6.toString(16).padStart(32, '0').split('').reverse().join('.') + '.ip6.arpa';
}

/**
 * 「同一个用户 / 一户」的网络键：IPv4 按单个地址，IPv6 按 /64 前缀
 * （同一户的设备、甚至同一设备的隐私地址都各不相同，但通常共用一个 /64）。
 * 限流与「本站观测」计数共用这一个键，避免 IPv6 用户换地址绕过限流或刷高计数。
 */
export function subscriberKey(parsed) {
  if (!parsed) return null;
  if (parsed.version === 4) return { key: `v4:${parsed.ip}`, scope: 'ip' };
  return { key: `v6/64:${(parsed.v6 >> 64n).toString(16).padStart(16, '0')}`, scope: '/64' };
}
