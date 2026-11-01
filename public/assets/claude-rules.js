// Claude 使用环境检测 —— 纯规则（无 DOM、无网络），浏览器与 node 测试共用。
// 思路参考：ip.net.coffee/claude（多出口分流对比）与 gokuscraper/claude-tester（浏览器中文特征），均为自行重写，未复制原代码。
// 所有分数都是启发式估计，不代表 Anthropic 的真实风控结果。
(function (root) {
  'use strict';

  // Anthropic「Supported Regions Policy」所列国家 / 地区（ISO 3166-1 alpha-2，共 185 个）
  // 来源：https://www.anthropic.com/supported-countries ，2026-11-01（UTC+8）抓取，页面标注 Effective Nov 12, 2026。
  // 页面说明：所列国家的属地（如波多黎各之于美国）同样支持；未列出的一律不支持。乌克兰不含克里米亚、顿涅茨克、赫尔松、卢甘斯克、扎波罗热。
  const SUPPORTED_REGIONS_SOURCE = { url: 'https://www.anthropic.com/supported-countries', fetchedAt: '2026-11-01', effective: '2026-11-12' };
  const SUPPORTED = new Set(('AD AE AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BZ CA CD CF CG CH CI CL CM CO CR CV CY CZ ' +
    'DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HN HR HT HU ID IE IL IN IQ IS IT JM JO JP ' +
    'KE KG KH KI KM KN KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MN MR MT MU MV MW MX MY MZ NA NE NG NI NL NO ' +
    'NP NR NZ OM PA PE PG PH PK PL PS PT PW PY QA RO RS RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SZ TD TG TH TJ TL TM TN TO ' +
    'TR TT TV TW TZ UA UG US UY UZ VA VC VN VU WS ZA ZM ZW').split(' '));
  // 常见属地 → 宗主国（页面说属地随宗主国）。只收录常见的几个，未收录的按「未列出」处理。
  const TERRITORY_OF = { PR: 'US', GU: 'US', VI: 'US', AS: 'US', MP: 'US', UM: 'US', GF: 'FR', GP: 'FR', MQ: 'FR', RE: 'FR', YT: 'FR',
    NC: 'FR', PF: 'FR', PM: 'FR', BL: 'FR', MF: 'FR', WF: 'FR', GI: 'GB', BM: 'GB', KY: 'GB', VG: 'GB', TC: 'GB', MS: 'GB', AI: 'GB',
    FK: 'GB', IM: 'GB', JE: 'GB', GG: 'GB', AW: 'NL', CW: 'NL', SX: 'NL', BQ: 'NL', GL: 'DK', FO: 'DK', CX: 'AU', CC: 'AU', NF: 'AU',
    AX: 'FI', SJ: 'NO' };

  // 返回 { status: 'supported' | 'partial' | 'unsupported' | 'unknown', cc, via }
  function regionStatus(cc) {
    const c = String(cc || '').toUpperCase();
    if (!/^[A-Z][A-Z0-9]$/.test(c) || c === 'XX') return { status: 'unknown', cc: c || null };
    if (c === 'T1') return { status: 'unknown', cc: c, tor: true }; // Cloudflare 对 Tor 出口的特殊代码
    if (c === 'UA') return { status: 'partial', cc: c };
    if (SUPPORTED.has(c)) return { status: 'supported', cc: c };
    if (TERRITORY_OF[c] && SUPPORTED.has(TERRITORY_OF[c])) return { status: 'supported', cc: c, via: TERRITORY_OF[c] };
    return { status: 'unsupported', cc: c };
  }

  // 解析 /cdn-cgi/trace 的 key=value 文本
  function parseTrace(text) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  }

  // 从 my.ip.cn 的纯文本里抠出 IP 与归属地（形如「ip：1.2.3.4 归属地：中国 江苏 电信」）
  function parseMyIpCn(text) {
    const s = String(text || '');
    const m = s.match(/((?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7})/i);
    if (!m) return null;
    const loc = s.match(/归属地[：:]\s*([^\n<]+)/);
    return { ip: m[1], location: loc ? loc[1].trim().replace(/\s+/g, ' ') : null };
  }

  const isV6 = (ip) => String(ip || '').includes(':');
  const family = (ip) => (isV6(ip) ? 6 : 4);

  // ---------- 上半部分：Claude 出口网络评分（0–100，越高越适合） ----------
  // 输入：
  //   claude: { ok, ip, loc, colo, warp, ms }      ← https://claude.ai/cdn-cgi/trace
  //   cf:     { ok, ip, loc } | null               ← https://1.1.1.1/cdn-cgi/trace
  //   cn:     { ok, ip, location } | null          ← https://my.ip.cn/（国内出口，只在本页对比，本页不会主动发给本站）
  //   site:   { ip }                               ← 本站 /api/ip 看到的地址
  //   ipInfo: /api/ip 对 Claude 出口 IP 的结果（analysis.type / score / risk，location.countryCode / timezone）
  //   tz:     { browserOffset, ipOffset, browserTz, ipTz }（分钟，东正西负）
  //   rtc:    { supported, publicIps: [] } | null
  const TYPE_PENALTY = { residential: 0, mobile: 0, business: 10, edu: 10, unknown: 12, datacenter: 35, proxy: 45 };
  const TYPE_TEXT = { residential: '家庭宽带', mobile: '移动网络', business: '商业宽带', edu: '教育网', unknown: '未知类型', datacenter: '数据中心 / 机房', proxy: '代理 / VPN / Tor' };

  function scoreNetwork(input) {
    const { claude, cf, cn, site, ipInfo, tz, rtc } = input || {};
    const items = [];
    const add = (id, level, title, detail, effect = 0) => items.push({ id, level, title, detail, effect });

    if (!claude || !claude.ok || !claude.ip) {
      add('reach', 'bad', '无法连接 claude.ai', '浏览器请求 claude.ai 失败或超时：当前网络很可能无法直接使用 Claude（被墙、代理规则未覆盖 claude.ai，或浏览器扩展拦截）。', -100);
      return finishNetwork(items, { score: 0, reachable: false });
    }
    add('reach', 'good', '可以连接 claude.ai', `Claude 看到的出口 IP：${claude.ip}${claude.colo ? `（Cloudflare 节点 ${claude.colo}）` : ''}`);

    // 1) 地区：优先用 claude.ai 自己的 Cloudflare 给出的 loc（最接近 Claude 实际看到的国家），其次用本站查询结果
    const cc = (claude.loc || (ipInfo && ipInfo.location && ipInfo.location.countryCode) || '').toUpperCase();
    const rs = regionStatus(cc);
    const ccSrc = claude.loc ? 'claude.ai 返回的 loc' : '本站 IP 归属地';
    let cap = 100;
    if (rs.status === 'unsupported') {
      cap = 10;
      add('region', 'bad', `出口地区不在支持列表：${cc}`, `按 ${ccSrc}，Claude 出口位于 ${cc}，不在 Anthropic 官方支持的国家 / 地区列表内，注册与使用都可能被拒绝或封号。`, -90);
    } else if (rs.status === 'partial') {
      add('region', 'warn', `出口地区：${cc}（部分支持）`, '乌克兰的克里米亚、顿涅茨克、赫尔松、卢甘斯克、扎波罗热地区不受支持，本站无法精确判断到州。', -10);
    } else if (rs.status === 'supported') {
      add('region', 'good', `出口地区受支持：${cc}${rs.via ? `（属 ${rs.via}）` : ''}`, `按 ${ccSrc} 判断，位于 Anthropic 官方支持列表内。`);
    } else {
      add('region', 'warn', '无法判断出口地区', rs.tor ? 'Cloudflare 将该出口标记为 Tor（T1），Claude 基本不可用。' : '没有拿到出口国家代码。', rs.tor ? -60 : -15);
      if (rs.tor) cap = Math.min(cap, 20);
    }

    // 2) 出口 IP 类型（复用本站纯净度规则）
    const a = ipInfo && ipInfo.analysis;
    if (a && a.type) {
      const pen = TYPE_PENALTY[a.type] ?? 12;
      const extra = a.risk === 'high' && pen < 35 ? 10 : 0;
      const level = pen >= 35 ? 'bad' : pen > 0 || extra ? 'warn' : 'good';
      const detail = pen >= 35
        ? '机房 / 代理出口被大量用户共用，是 Claude 风控（验证、限流、封号）最常见的诱因之一；家庭宽带或移动网络更稳妥。'
        : pen > 0 ? '不是典型家庭宽带，风险略高。' : '家庭宽带 / 移动网络，通常最不容易被风控。';
      add('iptype', level, `出口类型：${TYPE_TEXT[a.type] || a.typeText || a.type}（本站纯净度 ${a.score ?? '—'}）`, detail, -(pen + extra));
    } else {
      add('iptype', 'info', '出口类型：未知', '没有拿到本站对该 IP 的分析结果（可能被限流或查询失败），此项不计分。');
    }

    // 3) WARP
    if (claude.warp === 'on' || claude.warp === 'plus') {
      add('warp', 'warn', '正在使用 Cloudflare WARP', 'claude.ai 的 trace 显示 warp=on。WARP 出口 IP 被大量用户共用，部分地区的 WARP 出口会被识别为代理。', -10);
    }

    // 4) 分流：Claude 出口 vs 国内出口 vs 1.1.1.1 出口 vs 本站
    const cnIp = cn && cn.ok && cn.ip;
    if (cnIp && cnIp === claude.ip) {
      add('split', 'bad', 'Claude 流量没有走代理', `访问 claude.ai 与访问国内网站用的是同一个出口 ${cnIp}：代理规则没有覆盖 claude.ai，或你没有使用代理。`, -20);
    } else if (cnIp) {
      add('split', 'good', '分流正常', `访问国内网站走 ${cnIp}，访问 Claude 走 ${claude.ip}，两者不同。`);
    } else {
      add('split', 'info', '未获取到国内出口', 'my.ip.cn 无法访问（海外网络或被拦截时常见），无法对比分流，此项不计分。');
    }
    const cfIp = cf && cf.ok && cf.ip;
    if (cfIp && cfIp !== claude.ip && family(cfIp) === family(claude.ip)) {
      add('multi', 'info', '多个海外出口', `访问 1.1.1.1 走 ${cfIp}，访问 Claude 走 ${claude.ip}：代理按域名分流到了不同节点，正常现象，只需关注 Claude 这一条。`);
    }

    // 5) 时区：浏览器时区与 Claude 出口 IP 所在时区
    if (tz && tz.ipOffset != null && tz.browserOffset != null) {
      const diff = Math.abs(tz.ipOffset - tz.browserOffset);
      if (diff === 0) add('tz', 'good', '时区与出口一致', `浏览器 ${tz.browserTz || ''} 与出口 IP 所在 ${tz.ipTz || ''} 当前偏移相同。`);
      else add('tz', 'warn', '时区与出口不一致', `浏览器 ${tz.browserTz || ''} 与出口 IP 所在 ${tz.ipTz || ''} 相差 ${+(diff / 60).toFixed(1)} 小时。网页可以读取时区，不一致是常见的「使用代理」特征（启发式，不代表一定被风控）。`, diff >= 180 ? -10 : -5);
    } else add('tz', 'info', '时区：无法比较', '缺少出口 IP 的时区信息。');

    // 6) WebRTC：同地址族里出现了既不是 Claude 出口、也不是其他已知出口的公网 IP；若等于国内出口则是确定泄露
    if (rtc && rtc.supported) {
      const known = new Set([claude.ip, cfIp, site && site.ip].filter(Boolean));
      const pubs = (rtc.publicIps || []).filter(Boolean);
      const realLeak = cnIp && cnIp !== claude.ip ? pubs.filter((ip) => ip === cnIp) : [];
      const unknown = pubs.filter((ip) => !known.has(ip) && ip !== cnIp && family(ip) === family(claude.ip));
      if (realLeak.length) add('webrtc', 'bad', 'WebRTC 泄露了国内出口', `WebRTC 暴露了 ${realLeak[0]}，与国内出口相同：网页可以拿到你的真实 IP。建议在浏览器里限制 WebRTC，或让代理接管 UDP。`, -20);
      else if (unknown.length) add('webrtc', 'warn', 'WebRTC 出现其他公网 IP', `WebRTC 暴露了 ${[...new Set(unknown)].join('、')}，与 Claude 出口不同，可能是真实 IP 泄露。`, -10);
      else add('webrtc', 'good', 'WebRTC 未发现泄露', pubs.length ? 'WebRTC 看到的公网地址都属于已知出口。' : 'WebRTC 没有暴露公网地址。');
    } else if (rtc) add('webrtc', 'good', 'WebRTC 已禁用', '浏览器不支持或禁用了 WebRTC，不会通过它泄露地址。');

    // 7) 延迟（只作参考，过慢小幅扣分）
    if (claude.ms != null) {
      const ms = claude.ms;
      if (ms < 400) add('latency', 'good', `claude.ai 延迟 ${ms} ms`, '连接速度正常。');
      else if (ms < 1500) add('latency', 'info', `claude.ai 延迟 ${ms} ms`, '连接偏慢，但通常可用。');
      else add('latency', 'warn', `claude.ai 延迟 ${ms} ms`, '连接很慢，可能经常超时或断流。', -5);
    }

    let score = 100 + items.reduce((s, x) => s + Math.min(0, x.effect), 0);
    score = Math.max(0, Math.min(cap, score));
    return finishNetwork(items, { score, reachable: true, region: rs });
  }

  function finishNetwork(items, { score, reachable, region }) {
    let level, text;
    if (!reachable) { level = 'bad'; text = '无法连接 Claude'; }
    else if (region && region.status === 'unsupported') { level = 'bad'; text = '出口地区不受支持'; }
    else if (score >= 80) { level = 'good'; text = '适合使用'; }
    else if (score >= 55) { level = 'warn'; text = '基本可用，有风险项'; }
    else { level = 'bad'; text = '风险较高'; }
    return { score: Math.round(score), level, text, items };
  }

  // ---------- 下半部分：浏览器「中文用户特征」分（0–100，越高越像中国大陆用户） ----------
  // 参考 claude-tester 的思路重新设计权重：去掉 Emoji（只是 UA 推断，没有信息量），中文字体大幅降权（macOS 自带苹方、Windows 自带雅黑、Linux 常装 Noto CJK，误报极多）。
  const CN_TZ = ['Asia/Shanghai', 'Asia/Urumqi', 'Asia/Chongqing', 'Asia/Chungking', 'Asia/Harbin', 'Asia/Kashgar', 'PRC'];
  const GREATER_CN_TZ = ['Asia/Hong_Kong', 'Asia/Macau', 'Asia/Taipei'];
  const BROWSER_WEIGHTS = { timezone: 35, language: 30, locale: 15, offset: 10, fonts: 10 };

  function isHans(l) { return l === 'zh' || l.startsWith('zh-cn') || l.startsWith('zh-sg') || l.includes('hans'); }
  function isHant(l) { return l.startsWith('zh-tw') || l.startsWith('zh-hk') || l.startsWith('zh-mo') || l.includes('hant'); }

  // 输入：{ timezone, offsetMinutes（东正）, languages[], locale, fonts: { sc: [], tc: [] } }
  function scoreBrowser(env) {
    const e = env || {};
    const items = [];
    const push = (id, raw, ratio, title, detail) => {
      const w = BROWSER_WEIGHTS[id];
      const points = Math.round(w * ratio);
      items.push({ id, raw, ratio, weight: w, points, level: ratio >= 0.6 ? 'bad' : ratio >= 0.25 ? 'warn' : 'good', title, detail });
    };

    const tz = e.timezone || '';
    push('timezone', tz || '未知', CN_TZ.includes(tz) ? 1 : GREATER_CN_TZ.includes(tz) ? 0.6 : 0, '系统时区',
      CN_TZ.includes(tz) ? '中国大陆时区，是最强的中国用户特征。' : GREATER_CN_TZ.includes(tz) ? '港澳台时区。' : '非中国时区。');

    const langs = (e.languages || []).map((x) => String(x || '').toLowerCase()).filter(Boolean);
    const p = langs[0] || '';
    let lr = 0;
    if (isHans(p)) lr = 1; else if (isHant(p)) lr = 0.5; else if (langs.some(isHans)) lr = 0.6; else if (langs.some((l) => l.startsWith('zh'))) lr = 0.35;
    push('language', langs.join(', ') || '未知', lr, '浏览器语言', lr >= 1 ? '首选语言是简体中文。' : lr > 0 ? '语言列表里有中文。' : '语言列表里没有中文。');

    const loc = String(e.locale || '').toLowerCase();
    push('locale', e.locale || '未知', isHans(loc) ? 1 : loc.startsWith('zh') ? 0.5 : 0, 'Intl 区域格式', '日期 / 数字的区域设置，通常跟随系统语言。');

    const off = e.offsetMinutes;
    push('offset', off == null ? '未知' : `UTC${off >= 0 ? '+' : '-'}${Math.abs(off) / 60}`, off === 480 ? 0.5 : 0, '时区偏移',
      off === 480 ? 'UTC+8：中国，但新加坡、马来西亚、菲律宾、台湾、珀斯等也是 UTC+8，单独意义有限。' : '不是 UTC+8。');

    const sc = (e.fonts && e.fonts.sc) || [], tc = (e.fonts && e.fonts.tc) || [];
    // 只有「中国大陆特有、默认不会出现在其他地区系统上」的字体才给较高比例
    const CN_ONLY = ['SimSun', 'NSimSun', 'SimHei', 'KaiTi', 'FangSong', 'DengXian', 'WenQuanYi Micro Hei', 'WenQuanYi Zen Hei'];
    const strong = sc.filter((f) => CN_ONLY.includes(f));
    const fr = strong.length ? 0.6 : sc.length ? 0.3 : tc.length ? 0.2 : 0;
    push('fonts', [...sc, ...tc].slice(0, 5).join(', ') || '未检测到', fr, '中文字体（低权重）',
      '仅作参考：macOS 自带苹方、Windows 自带微软雅黑、Linux / 安卓常带 Noto CJK，海外用户也经常命中，因此权重只有 10。');

    const score = Math.min(100, items.reduce((s, x) => s + x.points, 0));
    const level = score > 60 ? 'bad' : score > 30 ? 'warn' : 'good';
    const text = score > 60 ? '很像中国大陆用户' : score > 30 ? '有部分中文用户特征' : '不像中国大陆用户';
    return { score, level, text, items };
  }

  // ---------- 总结论 ----------
  function overall(net, br) {
    if (!net) return { level: 'info', title: '检测中…', text: '' };
    if (net.level === 'bad') return { level: 'bad', title: net.text, text: '先解决上方标红的网络问题：Claude 是否可用主要取决于出口 IP 的地区与类型。' };
    if (br && br.level === 'bad') return { level: 'warn', title: '网络可用，但浏览器很像中国用户', text: '出口网络基本没问题；浏览器时区 / 语言暴露了中文环境。目前没有公开证据表明 claude.ai 会据此封号，但这是可被读取的特征，可酌情调整。' };
    if (net.level === 'warn') return { level: 'warn', title: net.text, text: '可以使用，但有扣分项，见下方明细。' };
    return { level: 'good', title: '环境良好', text: '出口地区受支持、IP 类型正常，未发现明显问题。' };
  }

  const api = { SUPPORTED, SUPPORTED_REGIONS_SOURCE, TERRITORY_OF, regionStatus, parseTrace, parseMyIpCn, scoreNetwork, scoreBrowser, overall, BROWSER_WEIGHTS, TYPE_PENALTY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CMIClaudeRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
