#!/usr/bin/env node
// 限流测试：IPv6 按 /64 计（与「本站观测」同一个键），绑定与进程内兜底都一样；开发倍数只在 DEV_MODE 下生效
import { rateLimited, limiterKey, limiterMode, limiterHealth, devMultiplier, _resetMemLimiter } from '../src/lib/ratelimit.js';
let fails = 0, n = 0;
const eq = (name, got, exp) => { n++; if (JSON.stringify(got) !== JSON.stringify(exp)) { fails++; console.error(`✘ ${name}: 期望 ${JSON.stringify(exp)} 实际 ${JSON.stringify(got)}`); } };
const warn = console.warn; console.warn = () => {};
const now = Date.parse('2026-10-31T12:00:00Z');

// 键
eq('IPv4 按地址', limiterKey('203.0.113.5'), 'v4:203.0.113.5');
eq('IPv4 映射地址按 IPv4', limiterKey('::ffff:203.0.113.5'), 'v4:203.0.113.5');
eq('IPv6 按 /64', [limiterKey('2001:db8:1:2::1'), limiterKey('2001:db8:1:2:ffff:eeee:dddd:cccc')], ['v6/64:20010db800010002', 'v6/64:20010db800010002']);
eq('不同 /64 不同键', limiterKey('2001:db8:1:3::1') !== limiterKey('2001:db8:1:2::1'), true);
eq('无 IP → local', [limiterKey(null), limiterKey('garbage')], ['local', 'local']);

// 进程内兜底（没有绑定）：同一 /64 下换 20 个地址也只算一个人
_resetMemLimiter();
const env = { LOOKUP_RATE_LIMIT: '20' };
const res = [];
for (let i = 0; i < 25; i++) res.push((await rateLimited(env, 'lookup', `2001:db8:1:2::${(i + 1).toString(16)}`, now)).limited);
eq('memory：同一 /64 第 21 次起被限', [res.slice(0, 20).every((x) => !x), res.slice(20).every((x) => x)], [true, true]);
eq('memory：另一个 /64 不受影响', (await rateLimited(env, 'lookup', '2001:db8:9:9::1', now)).limited, false);
eq('memory：IPv4 仍按单个地址', [(await rateLimited(env, 'lookup', '203.0.113.5', now)).limited, (await rateLimited(env, 'lookup', '203.0.113.6', now)).limited], [false, false]);
eq('memory：60 秒后恢复', (await rateLimited(env, 'lookup', '2001:db8:1:2::77', now + 61_000)).limited, false);
eq('memory：桶互不影响', (await rateLimited(env, 'seen', '2001:db8:1:2::1', now)).limited, false);

// 绑定：传给绑定的 key 同样是 /64
function fakeBinding(limit) {
  const seen = new Map(); const keys = [];
  return { keys, async limit({ key }) { keys.push(key); const c = (seen.get(key) || 0) + 1; seen.set(key, c); return { success: c <= limit }; } };
}
_resetMemLimiter();
for (const bucket of ['self', 'lookup', 'seen']) {
  const binding = fakeBinding(3);
  const benv = { SELF_LIMITER: binding, LOOKUP_LIMITER: binding, SEEN_LIMITER: binding };
  const r = [];
  for (let i = 0; i < 5; i++) r.push(await rateLimited(benv, bucket, `2001:db8:abcd:1:${i + 1}::1`, now));
  eq(`binding ${bucket}：键为 /64、第 4 次起被限`, [binding.keys.every((k) => k === `${bucket}:v6/64:20010db8abcd0001`), r.map((x) => x.limited), r[0].via],
    [true, [false, false, false, true, true], 'binding']);
}
// 绑定抛错 → 本次退回内存
_resetMemLimiter();
const broken = { LOOKUP_LIMITER: { async limit() { throw new Error('boom'); } } };
eq('binding 出错 → memory', (await rateLimited(broken, 'lookup', '203.0.113.9', now)).via, 'memory');

// 开发倍数：仅 DEV_MODE=true 生效，生效时不用绑定
eq('倍数仅 DEV_MODE 生效', [devMultiplier({ RATE_LIMIT_MULTIPLIER: '10' }), devMultiplier({ DEV_MODE: 'true', RATE_LIMIT_MULTIPLIER: '10' }), devMultiplier({ DEV_MODE: 'true' }), devMultiplier({ DEV_MODE: 'true', RATE_LIMIT_MULTIPLIER: 'abc' })], [1, 10, 1, 1]);
_resetMemLimiter();
const devBinding = fakeBinding(20);
const denv = { DEV_MODE: 'true', RATE_LIMIT_MULTIPLIER: '10', LOOKUP_LIMITER: devBinding };
const d = [];
for (let i = 0; i < 201; i++) d.push((await rateLimited(denv, 'lookup', null, now)).limited);
eq('DEV ×10：lookup 200 次内不限、第 201 次限，且不调用绑定', [d.slice(0, 200).every((x) => !x), d[200], devBinding.keys.length, limiterMode(denv, 'lookup')], [true, true, 0, 'memory-dev']);
const prodEnv = { RATE_LIMIT_MULTIPLIER: '10', LOOKUP_LIMITER: fakeBinding(20), SELF_LIMITER: fakeBinding(60), SEEN_LIMITER: fakeBinding(10) };
eq('线上（无 DEV_MODE）忽略倍数、用绑定', [limiterMode(prodEnv, 'lookup'), limiterHealth(prodEnv).warnings.length], ['binding', 0]);
eq('health 显示开发倍数与阈值', [limiterHealth(denv).rateLimit.lookup.limitPerMinute, limiterHealth(denv).warnings.some((w) => w.includes('RATE_LIMIT_MULTIPLIER=10'))], [200, true]);

console.warn = warn;
console.log(`${fails ? '✘' : '✔'} 限流测试 ${n} 项，失败 ${fails} 项`);
process.exit(fails ? 1 : 0);
