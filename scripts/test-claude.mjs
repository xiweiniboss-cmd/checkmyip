#!/usr/bin/env node
// Claude 环境检测：规则测试（public/assets/claude-rules.js，浏览器脚本，用 vm 载入）
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = { globalThis: null }; ctx.globalThis = ctx;
vm.runInNewContext(readFileSync(new URL('../public/assets/claude-rules.js', import.meta.url), 'utf8'), ctx);
const R = ctx.CMIClaudeRules;
let fails = 0, n = 0;
const eq = (name, got, exp) => { n++; if (JSON.stringify(got) !== JSON.stringify(exp)) { fails++; console.error(`✘ ${name}: 期望 ${JSON.stringify(exp)} 实际 ${JSON.stringify(got)}`); } };
const ok = (name, cond) => eq(name, !!cond, true);
const item = (r, id) => r.items.find((x) => x.id === id);

// ---- 支持地区列表 ----
eq('支持列表 185 个', R.SUPPORTED.size, 185);
ok('全部是两位大写代码', [...R.SUPPORTED].every((c) => /^[A-Z]{2}$/.test(c)));
for (const c of ['CN', 'HK', 'MO', 'RU', 'BY', 'IR', 'KP', 'SY', 'CU', 'VE', 'MM', 'AF', 'YE']) eq(`${c} 不支持`, R.regionStatus(c).status, 'unsupported');
for (const c of ['US', 'GB', 'JP', 'SG', 'TW', 'KR', 'DE', 'TR', 'CI', 'ST', 'VA', 'PS', 'ER', 'NI', 'ZW', 'AG', 'TT']) eq(`${c} 支持`, R.regionStatus(c).status, 'supported');
eq('小写也可', R.regionStatus('us').status, 'supported');
eq('属地 PR → US', [R.regionStatus('PR').status, R.regionStatus('PR').via], ['supported', 'US']);
eq('乌克兰部分支持', R.regionStatus('UA').status, 'partial');
eq('XX 未知', R.regionStatus('XX').status, 'unknown');
eq('空值未知', R.regionStatus('').status, 'unknown');
eq('T1 = Tor', R.regionStatus('T1').tor, true);
eq('来源日期', [R.SUPPORTED_REGIONS_SOURCE.fetchedAt, R.SUPPORTED_REGIONS_SOURCE.effective], ['2026-11-01', '2026-11-12']);

// ---- 解析 ----
const tr = R.parseTrace('fl=1\nh=claude.ai\nip=203.0.113.9\nts=1\nvisit_scheme=https\nuag=x=y\ncolo=NRT\nloc=JP\nwarp=off\n');
eq('trace 解析', [tr.ip, tr.loc, tr.colo, tr.warp, tr.uag], ['203.0.113.9', 'JP', 'NRT', 'off', 'x=y']);
eq('my.ip.cn 解析', R.parseMyIpCn('ip：114.222.1.2 归属地：中国 江苏 南京   电信\n'), { ip: '114.222.1.2', location: '中国 江苏 南京 电信' });
eq('my.ip.cn IPv6', R.parseMyIpCn('ip：240e:1:2::3 归属地：中国').ip, '240e:1:2::3');
eq('my.ip.cn 无 IP', R.parseMyIpCn('<html>blocked</html>'), null);

// ---- 网络评分 ----
const claude = (o = {}) => ({ ok: true, ip: '203.0.113.9', loc: 'US', colo: 'LAX', warp: 'off', ms: 180, ...o });
const info = (type, o = {}) => ({ analysis: { type, typeText: type, score: 90, risk: 'low', ...o }, location: { countryCode: 'US', timezone: 'America/Los_Angeles' } });
const cn = { ok: true, ip: '114.222.1.2' };
const tzSame = { browserOffset: -420, ipOffset: -420, browserTz: 'America/Los_Angeles', ipTz: 'America/Los_Angeles' };
const tzCN = { browserOffset: 480, ipOffset: -420, browserTz: 'Asia/Shanghai', ipTz: 'America/Los_Angeles' };

let r = R.scoreNetwork({ claude: { ok: false } });
eq('无法连接 → 0 分', [r.score, r.level, r.text], [0, 'bad', '无法连接 Claude']);

r = R.scoreNetwork({ claude: claude(), cn, ipInfo: info('residential'), tz: tzSame, rtc: { supported: true, publicIps: ['203.0.113.9'] } });
eq('理想环境 100 分', [r.score, r.level], [100, 'good']);
eq('分流正常', item(r, 'split').level, 'good');
eq('WebRTC 无泄露', item(r, 'webrtc').level, 'good');

r = R.scoreNetwork({ claude: claude({ loc: 'HK' }), cn, ipInfo: info('residential'), tz: tzSame });
ok('香港出口封顶 10', r.score <= 10);
eq('香港出口结论', [r.level, r.text, item(r, 'region').level], ['bad', '出口地区不受支持', 'bad']);

r = R.scoreNetwork({ claude: claude({ loc: 'CN', ip: cn.ip }), cn, ipInfo: info('residential') });
eq('没走代理', [item(r, 'split').level, r.level], ['bad', 'bad']);

r = R.scoreNetwork({ claude: claude(), ipInfo: info('datacenter'), tz: tzSame });
eq('机房 IP 扣 35', r.score, 65);
eq('机房 IP 等级', [item(r, 'iptype').level, r.level], ['bad', 'warn']);
eq('国内出口缺失不扣分', item(r, 'split').effect, 0);

r = R.scoreNetwork({ claude: claude(), ipInfo: info('proxy'), tz: tzCN });
eq('代理 + 时区差 15h → 45 分', [r.score, r.level], [45, 'bad']);

r = R.scoreNetwork({ claude: claude({ warp: 'on' }), ipInfo: info('residential'), tz: tzSame });
eq('WARP 扣 10', [r.score, item(r, 'warp').level], [90, 'warn']);

r = R.scoreNetwork({ claude: claude(), ipInfo: info('business', { risk: 'high' }), tz: tzSame });
eq('商业宽带 + 高风险 扣 20', r.score, 80);

r = R.scoreNetwork({ claude: claude(), cn, ipInfo: info('residential'), tz: tzSame, rtc: { supported: true, publicIps: ['114.222.1.2'] } });
eq('WebRTC 泄露国内 IP', [item(r, 'webrtc').level, r.score], ['bad', 80]);
r = R.scoreNetwork({ claude: claude(), ipInfo: info('residential'), tz: tzSame, rtc: { supported: true, publicIps: ['198.51.100.7'] } });
eq('WebRTC 其他公网 IP', [item(r, 'webrtc').level, r.score], ['warn', 90]);
r = R.scoreNetwork({ claude: claude(), ipInfo: info('residential'), tz: tzSame, rtc: { supported: true, publicIps: ['2001:db8::1'] } });
eq('WebRTC 不同地址族不算泄露', item(r, 'webrtc').level, 'good');
r = R.scoreNetwork({ claude: claude(), cf: { ok: true, ip: '198.51.100.7' }, ipInfo: info('residential'), tz: tzSame, rtc: { supported: true, publicIps: ['198.51.100.7'] } });
eq('WebRTC 等于另一个已知出口不算泄露', [item(r, 'webrtc').level, item(r, 'multi').level], ['good', 'info']);
r = R.scoreNetwork({ claude: claude(), ipInfo: info('residential'), tz: tzSame, rtc: { supported: false } });
eq('WebRTC 禁用', item(r, 'webrtc').level, 'good');

r = R.scoreNetwork({ claude: claude({ ms: 2500 }), ipInfo: info('residential'), tz: tzSame });
eq('高延迟扣 5', [r.score, item(r, 'latency').level], [95, 'warn']);
r = R.scoreNetwork({ claude: claude({ loc: 'UA' }), ipInfo: info('residential'), tz: tzSame });
eq('乌克兰部分支持扣 10', [r.score, item(r, 'region').level], [90, 'warn']);
r = R.scoreNetwork({ claude: claude({ loc: 'T1' }), ipInfo: info('proxy'), tz: tzSame });
ok('Tor 封顶 20', r.score <= 20);
r = R.scoreNetwork({ claude: claude({ loc: null }), ipInfo: info('residential') });
eq('无 loc 回退本站归属地', item(r, 'region').level, 'good');
r = R.scoreNetwork({ claude: claude(), ipInfo: null });
eq('查询失败不计分', [item(r, 'iptype').level, item(r, 'iptype').effect], ['info', 0]);
for (const t of Object.keys(R.TYPE_PENALTY)) { const s = R.scoreNetwork({ claude: claude(), ipInfo: info(t), tz: tzSame }).score; ok(`分数范围 ${t}`, s >= 0 && s <= 100); }

// ---- 浏览器评分 ----
const fonts0 = { sc: [], tc: [] };
let b = R.scoreBrowser({ timezone: 'Asia/Shanghai', offsetMinutes: 480, languages: ['zh-CN', 'zh'], locale: 'zh-CN', fonts: { sc: ['Microsoft YaHei', 'SimSun'], tc: [] } });
eq('典型大陆环境', [b.score, b.level], [91, 'bad']);
b = R.scoreBrowser({ timezone: 'America/New_York', offsetMinutes: -300, languages: ['en-US'], locale: 'en-US', fonts: fonts0 });
eq('典型美国环境 0 分', [b.score, b.level], [0, 'good']);
b = R.scoreBrowser({ timezone: 'America/Los_Angeles', offsetMinutes: -420, languages: ['en-US'], locale: 'en-US', fonts: { sc: ['PingFang SC', 'Hiragino Sans GB'], tc: ['PingFang TC'] } });
eq('macOS 自带苹方只加 3 分', [b.score, b.level], [3, 'good']);
b = R.scoreBrowser({ timezone: 'America/Los_Angeles', offsetMinutes: -420, languages: ['en-US', 'zh-CN'], locale: 'en-US', fonts: fonts0 });
eq('次要语言简体', b.score, 18);
b = R.scoreBrowser({ timezone: 'Asia/Shanghai', offsetMinutes: 480, languages: ['en-US'], locale: 'en-US', fonts: fonts0 });
eq('只改了语言，时区仍是上海', [b.score, b.level], [40, 'warn']);
b = R.scoreBrowser({ timezone: 'Asia/Taipei', offsetMinutes: 480, languages: ['zh-TW'], locale: 'zh-TW', fonts: { sc: [], tc: ['Microsoft JhengHei'] } });
eq('台湾繁体', [b.score, b.level], [51, 'warn']);
b = R.scoreBrowser({ timezone: 'Asia/Singapore', offsetMinutes: 480, languages: ['en-SG'], locale: 'en-SG', fonts: fonts0 });
eq('新加坡 UTC+8 只加 5', b.score, 5);
b = R.scoreBrowser({});
eq('空输入不报错', [b.score, b.items.length], [0, 5]);
ok('不含 Emoji 项', !b.items.some((x) => /emoji/i.test(x.id)));
eq('权重和 100', Object.values(R.BROWSER_WEIGHTS).reduce((a, x) => a + x, 0), 100);
ok('字体权重最低档', R.BROWSER_WEIGHTS.fonts <= 10);

// ---- 总结论 ----
const good = { level: 'good', text: '适合使用' }, warn = { level: 'warn', text: '基本可用，有风险项' }, bad = { level: 'bad', text: '风险较高' };
eq('网络差优先', R.overall(bad, { level: 'good' }).level, 'bad');
eq('网络好但浏览器像中国用户', R.overall(good, { level: 'bad' }).level, 'warn');
eq('都好', R.overall(good, { level: 'good' }).level, 'good');
eq('网络中等', R.overall(warn, { level: 'warn' }).level, 'warn');

if (fails) { console.error(`\n${fails}/${n} 项失败`); process.exit(1); }
console.log(`✔ Claude 环境规则测试全部通过（${n} 项）`);
