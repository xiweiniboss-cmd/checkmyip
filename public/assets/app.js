// checkmyip 前端主逻辑
(function () {
  'use strict';
  const CFG = window.CHECKMYIP_CONFIG || {};
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // 资源版本号由 scripts/stamp-assets.mjs 写入 index.html 的 meta，用于刷新图标缓存
  const ASSET_V = document.querySelector('meta[name="checkmyip-asset-version"]')?.content;
  const ICONS = '/assets/icons.svg' + (ASSET_V ? `?v=${ASSET_V}` : '');
  const icon = (id) => `<svg viewBox="0 0 24 24"><use href="${ICONS}#${id}"/></svg>`;
  const LEVEL_ICON = { good: 'ok', warn: 'warn', bad: 'bad', info: 'info' };
  const TYPE_CLASS = { residential: 'good', mobile: 'teal', business: 'warn', edu: 'purple', datacenter: 'bad', proxy: 'bad', unknown: 'soft' };
  const RISK_CLASS = { low: 'good', medium: 'warn', high: 'bad' };

  const state = { self: null, view: null, fp: null, rtc: null, v4: undefined, v6: undefined };

  // ---------- 主题 ----------
  $('#themeBtn').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('cmi-theme', next); } catch (e) {}
  });

  // ---------- 提示 ----------
  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800); }

  // ---------- 导航高亮 ----------
  const navLinks = [...document.querySelectorAll('.nav a')];
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) navLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id));
  }, { rootMargin: '-45% 0px -50% 0px' });
  document.querySelectorAll('main .section').forEach((s) => io.observe(s));

  // ---------- API ----------
  async function api(ip) {
    const r = await fetch('/api/ip' + (ip ? `?ip=${encodeURIComponent(ip)}` : ''), { headers: { accept: 'application/json' } });
    let d = null;
    try { d = await r.json(); } catch (e) {}
    if (!d) throw new Error(`服务暂时不可用（HTTP ${r.status}）`);
    if (!d.ok) throw new Error(d.message || '查询失败');
    return d;
  }

  // ---------- IP 卡片渲染 ----------
  function locText(l) {
    const parts = [l.region, l.city].filter(Boolean);
    const uniq = parts.filter((x, i) => parts.indexOf(x) === i);
    return uniq.join(' · ') || '—';
  }

  function renderIp(d) {
    state.view = d;
    renderSharing();
    const a = d.analysis, l = d.location, n = d.network;
    const mine = d.query === 'self';
    $('#ipEyebrow').textContent = mine ? '本站看到的你的 IP' : '查询的 IP';
    $('#heroTitle').textContent = mine ? '你的 IP 纯净吗？' : `IP 查询：${d.ip}`;
    $('#mineBtn').hidden = mine;
    const ipEl = $('#ipValue');
    ipEl.textContent = d.ip; ipEl.classList.remove('skel'); ipEl.classList.toggle('v6', d.version === 6);
    $('#ipVersionChips').innerHTML = `<span class="badge blue">IPv${d.version}</span>${mine && d.seenVia && d.seenVia !== 'cf-connecting-ip' ? `<span class="badge soft" title="本地开发模式">${esc(d.seenVia)}</span>` : ''}`;

    const badges = [`<span class="badge lg ${TYPE_CLASS[a.type]}"><span class="dot"></span>${esc(a.typeText)}</span>`,
      `<span class="badge lg ${RISK_CLASS[a.risk]}">风险：${esc(a.riskText)}</span>`];
    if (a.incomplete) badges.push('<span class="badge lg warn" title="部分数据源查询失败，结果可能不准确">⚠ 数据不完整</span>');
    for (const lb of a.labels) if (lb !== a.typeText && lb !== '数据不完整') badges.push(`<span class="badge soft">${esc(lb)}</span>`);
    $('#ipBadges').innerHTML = badges.join('');

    const country = l.country ? `${esc(l.country)}${l.countryCode ? ` <span class="sub2">${esc(l.countryCode)}${l.countryEn && l.countryEn !== l.country ? ' · ' + esc(l.countryEn) : ''}</span>` : ''}` : '—';
    const org = n.org || n.isp || '—';
    const asnLine = n.asn ? `AS${n.asn}${n.asnName ? ` <span class="sub2">${esc(n.asnName)}</span>` : ''}` : '—';
    const ispSub = n.isp && n.isp !== n.org ? `<span class="sub2">${esc(n.isp)}</span>` : (n.cloudProvider.length ? `<span class="sub2">云厂商：${esc(n.cloudProvider.join('、'))}</span>` : '');
    $('#ipKv').innerHTML = [
      ['国家 / 地区', country], ['省份 / 城市', esc(locText(l))], ['ASN', asnLine], ['运营商 / 组织', esc(org) + ispSub],
      ['时区', l.timezone ? `${esc(l.timezone)} <span class="sub2">${esc(tzOffsetOf(l.timezone) || '')}</span>` : '—'],
      ['反向解析 (PTR)', n.ptr ? `<span class="mono-in">${esc(n.ptr)}</span>` : '<span class="muted">无记录</span>'],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

    const strip = $('#locStrip');
    if (l.latitude != null && l.longitude != null) {
      const lat = Number(l.latitude).toFixed(4), lon = Number(l.longitude).toFixed(4);
      const name = encodeURIComponent([l.country, l.region, l.city].filter(Boolean).join(' '));
      strip.innerHTML = `${icon('pin')}<span>大致位置</span><span class="coords">${lat}, ${lon}</span>${d.connection?.colo ? `<span class="badge soft">CF 节点 ${esc(d.connection.colo)}</span>` : ''}
        <span class="links"><a href="https://uri.amap.com/marker?position=${lon},${lat}&name=${name}&coordinate=wgs84" target="_blank" rel="noopener">高德地图</a><a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=9/${lat}/${lon}" target="_blank" rel="noopener">OpenStreetMap</a></span>`;
      strip.hidden = false;
    } else strip.hidden = true;

    // 评分
    const card = $('#scoreCard');
    const color = a.score >= 80 ? '#10b981' : a.score >= 50 ? '#f59e0b' : '#ef4444';
    card.style.setProperty('--gauge-color', color);
    $('#gaugeBar').setAttribute('stroke-dasharray', `${Math.max(0.5, a.score)} 100`);
    animateNum($('#scoreNum'), a.score);
    $('#scoreLabel').textContent = a.incomplete ? '数据不完整' : a.score >= 80 ? '较为纯净' : a.score >= 50 ? '一般' : '纯净度低';
    $('#scoreSummary').innerHTML = summaryOf(d);
    const alertEl = $('#scoreAlert');
    if (a.incomplete) {
      const MISS = { geo: '地理位置 / ASN', asn: 'ASN', ptr: '反向解析' };
      const miss = [...new Set((a.missing || []).map((k) => MISS[k]).filter(Boolean))].join('、');
      alertEl.innerHTML = `<b>数据不完整</b>：${esc(miss || 'ASN')} 查询失败，无法判断网络类型。分数已封顶 60、风险至少为「中」，请稍后重试。`;
      alertEl.hidden = false;
    } else alertEl.hidden = true;
    const rep = $('#repNote');
    if (a.reputation && !a.reputation.used) { rep.textContent = a.reputation.note; rep.hidden = false; }
    else if (a.reputation) { rep.textContent = `已参考信誉库：${a.reputation.sources.join('、')}`; rep.hidden = false; }
    else rep.hidden = true;
    $('#typeText').textContent = a.typeText; $('#riskText').textContent = a.riskText; $('#confText').textContent = a.confidenceText;

    $('#signals').innerHTML = a.signals.map((s) => `<li class="signal ${s.level}"><span class="sig-ico">${icon(LEVEL_ICON[s.level] || 'info')}</span>
      <div><div class="sig-name">${esc(s.name)}</div><div class="sig-detail">${esc(s.detail)}</div></div>
      <span class="sig-effect ${s.effect < 0 ? 'neg' : s.effect > 0 ? 'pos' : ''}">${s.effect > 0 ? '+' : ''}${s.effect || '±0'}</span></li>`).join('');
    $('#scoreNote').textContent = a.note;
    const src = [d.sources.geo && `位置：${d.sources.geo}`, d.sources.ptr && `PTR：${d.sources.ptr}`].filter(Boolean).join(' · ');
    $('#srcLine').textContent = src;
    if (d.sources.dataUpdatedAt) $('#dataMeta').textContent = `IP 段数据更新：${new Date(d.sources.dataUpdatedAt).toLocaleDateString('zh-CN')}`;
  }

  function summaryOf(d) {
    const a = d.analysis, n = d.network;
    const who = esc(n.isp || n.asnName || n.org || '未知运营商');
    const neg = a.signals.filter((x) => x.effect < 0).sort((x, y) => x.effect - y.effect).map((x) => esc(x.name));
    if (a.incomplete) return `部分数据源查询失败，暂时无法判断 <b>${esc(d.ip)}</b> 的网络类型。`;
    if (a.risk === 'low') return `该 IP 属于 <b>${who}</b>，判断为<b>${esc(a.typeText)}</b>，未发现明显的机房 / 代理特征。`;
    return `该 IP 属于 <b>${who}</b>，判断为<b>${esc(a.typeText)}</b>。主要扣分项：${neg.slice(0, 3).join('、') || '无'}。`;
  }

  function renderIpError(msg) {
    $('#scoreSummary').textContent = '';
    $('#scoreAlert').hidden = true; $('#repNote').hidden = true;
    $('#ipValue').classList.remove('skel');
    $('#ipValue').textContent = '—';
    $('#ipBadges').innerHTML = '';
    $('#ipKv').innerHTML = `<div style="grid-column:1/-1;border:0"><div class="error-box">${esc(msg)}</div></div>`;
    $('#locStrip').hidden = true;
    $('#signals').innerHTML = '';
    $('#scoreNum').textContent = '--'; $('#scoreLabel').textContent = '无法评分';
    $('#gaugeBar').setAttribute('stroke-dasharray', '0 100');
    state.view = null;
    $('#shHeadline').textContent = '无法估算'; $('#shHeadline').className = 'sh-headline soft';
    $('#shScene').textContent = ''; $('#shBadges').innerHTML = ''; $('#shReasons').innerHTML = ''; $('#shEvidence').hidden = true;
  }

  function setLoading() {
    $('#ipValue').classList.add('skel');
    $('#ipBadges').innerHTML = '<span class="badge skel">加载中</span>';
    $('#signals').innerHTML = '<li class="skel-row"></li><li class="skel-row"></li><li class="skel-row"></li>';
    $('#scoreLabel').textContent = '计算中';
    $('#shHeadline').className = 'sh-headline skel';
    $('#shReasons').innerHTML = '<li class="skel-row"></li><li class="skel-row"></li>';
  }

  function animateNum(el, to) {
    const from = Number(el.textContent) || 0; const t0 = performance.now();
    const step = (t) => { const k = Math.min(1, (t - t0) / 800); el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  // ---------- 时区工具 ----------
  function offsetMinutes(tz) {
    try {
      const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName').value;
      const m = s.match(/GMT([+-])(\d{2}):?(\d{2})?/); if (!m) return 0;
      return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
    } catch (e) { return null; }
  }
  function tzOffsetOf(tz) { const m = offsetMinutes(tz); if (m == null) return null; const a = Math.abs(m); return `UTC${m < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`; }

  // ---------- 查询 ----------
  async function show(ip) {
    setLoading();
    try {
      const d = ip ? await api(ip) : (state.self || await loadSelf());
      renderIp(d);
      const u = new URL(location.href);
      if (ip) u.searchParams.set('ip', d.ip); else u.searchParams.delete('ip');
      history.replaceState(null, '', u);
    } catch (e) { renderIpError(e.message); }
  }
  async function loadSelf() { state.self = await api(); renderEnv(); renderStack(); checkRtc(); reportSeen(); return state.self; }

  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#searchInput').value.trim();
    if (!v) { toast('请输入要查询的 IP'); return; }
    show(v);
  });
  $('#mineBtn').addEventListener('click', () => { $('#searchInput').value = ''; show(null); });
  $('#copyBtn').addEventListener('click', async () => {
    const ip = state.view?.ip; if (!ip) return;
    try { await navigator.clipboard.writeText(ip); toast('已复制 ' + ip); } catch (e) { toast('复制失败，请手动选择'); }
  });

  // ---------- IPv4 / IPv6 ----------
  // 依次尝试各探测地址；返回了错误地址族（如 v4 子域其实是双栈、走了 IPv6）就继续下一个
  const familyOk = (ip, family) => (family === 6 ? ip.includes(':') : !ip.includes(':'));
  async function probe(urls, family) {
    for (const u of urls || []) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined, cache: 'no-store' });
        if (!r.ok) continue;
        const t = (await r.text()).trim();
        let ip = t;
        if (t.startsWith('{')) { try { ip = JSON.parse(t).ip; } catch (e) { continue; } }
        if (!ip || !/^[0-9a-f.:]+$/i.test(ip)) continue;
        if (family && !familyOk(ip, family)) continue;
        return ip;
      } catch (e) { /* 下一个 */ }
    }
    return null;
  }
  function detectStack() {
    const done = () => { renderStack(); renderEnv(); renderRtc(); renderSharing(); };
    probe(CFG.ipv4, 4).then((ip) => { state.v4 = ip; done(); });
    probe(CFG.ipv6, 6).then((ip) => { state.v6 = ip; done(); });
  }
  function renderStack() {
    const seen = state.self?.ip;
    const row = (proto, ip) => {
      if (ip === undefined) return `<li><span class="proto">${proto}</span><span class="val skel">检测中</span></li>`;
      if (!ip) return `<li><span class="proto">${proto}</span><span class="val none">未检测到${proto === 'IPv6' ? '（网络可能不支持 IPv6）' : ''}</span></li>`;
      const same = seen && ip === seen;
      return `<li><span class="proto">${proto}</span><span class="val">${esc(ip)}</span>${same ? '<span class="badge good tag">本站所见</span>' : ''}</li>`;
    };
    $('#stackList').innerHTML = row('IPv4', state.v4) + row('IPv6', state.v6);
    $('#seenProto').textContent = state.self ? `IPv${state.self.version}（${state.self.ip}）` : '—';
  }

  // ---------- 环境一致性 ----------
  const LANG_BY_COUNTRY = { CN: ['zh'], HK: ['zh', 'en'], MO: ['zh', 'pt'], TW: ['zh'], SG: ['en', 'zh', 'ms', 'ta'], JP: ['ja'], KR: ['ko'],
    US: ['en', 'es'], GB: ['en'], CA: ['en', 'fr'], AU: ['en'], NZ: ['en'], IE: ['en'], DE: ['de'], AT: ['de'], CH: ['de', 'fr', 'it'],
    FR: ['fr'], ES: ['es', 'ca'], IT: ['it'], NL: ['nl'], BE: ['nl', 'fr'], RU: ['ru'], UA: ['uk', 'ru'], BR: ['pt'], PT: ['pt'],
    MX: ['es'], AR: ['es'], IN: ['en', 'hi'], TH: ['th'], VN: ['vi'], ID: ['id'], MY: ['ms', 'en', 'zh'], PH: ['en', 'fil'],
    TR: ['tr'], PL: ['pl'], SE: ['sv'], NO: ['nb', 'no', 'nn'], FI: ['fi'], DK: ['da'], IL: ['he'], SA: ['ar'], AE: ['ar', 'en'] };

  function envChecks() {
    const s = state.self, f = state.fp;
    if (!s || !f) return null;
    const out = [];
    // 时区
    if (s.location.timezone && f.timezone) {
      const a = offsetMinutes(s.location.timezone), b = -new Date().getTimezoneOffset();
      const ok = a === b;
      out.push({ level: ok ? 'good' : 'warn', title: ok ? '时区一致' : '时区不一致',
        text: `浏览器 ${f.timezone}（${tzOffsetOf(f.timezone) || f.tzOffset}），IP 所在 ${s.location.timezone}（${tzOffsetOf(s.location.timezone) || '?'}）` });
    } else out.push({ level: 'info', title: '时区', text: '缺少 IP 时区信息，无法比较。' });
    // 语言
    const cc = s.location.countryCode;
    const langs = f.languages.map((x) => x.toLowerCase());
    const expect = LANG_BY_COUNTRY[cc];
    if (expect) {
      const ok = langs.some((l) => expect.some((e) => l === e || l.startsWith(e + '-')));
      out.push({ level: ok ? 'good' : 'warn', title: ok ? '语言与 IP 地区相符' : '语言与 IP 地区不符', text: `浏览器语言 ${f.languages.slice(0, 3).join(', ')}；IP 位于 ${s.location.country || cc}` });
    } else out.push({ level: 'info', title: '语言', text: `浏览器语言 ${f.languages.slice(0, 3).join(', ')}（该地区未收录常用语言，不作判断）` });
    // WebRTC
    if (state.rtc) {
      const v = rtcVerdict();
      out.push({ level: v.level === 'bad' ? 'bad' : v.level === 'warn' ? 'warn' : 'good', title: `WebRTC：${v.short}`, text: v.envText });
    }
    // IPv4 / IPv6 出口
    if (state.v4 && state.v6 && state.self) {
      out.push({ level: 'info', title: '双栈网络', text: '同时具有 IPv4 与 IPv6 出口；若使用代理，请确认两者都经过代理。' });
    }
    if (f.webdriver) out.push({ level: 'warn', title: '自动化浏览器', text: '检测到 navigator.webdriver，网站可能识别为自动化环境。' });
    return out;
  }
  function renderEnv() {
    const list = envChecks();
    if (!list) return;
    $('#envList').innerHTML = list.map((c) => `<li class="${c.level}"><span class="ck">${icon(LEVEL_ICON[c.level])}</span><div><b>${esc(c.title)}</b><p>${esc(c.text)}</p></div></li>`).join('');
    const worst = list.some((c) => c.level === 'bad') ? 'bad' : list.some((c) => c.level === 'warn') ? 'warn' : 'good';
    $('#envDot').className = 'status-dot ' + worst;
  }

  // ---------- WebRTC ----------
  let rtcRunning = false;
  async function checkRtc() {
    if (rtcRunning) return; rtcRunning = true;
    const btn = $('#rtcBtn'); btn.disabled = true;
    state.rtc = null;
    setVerdict('loading', '正在检测…', '正在通过 STUN 服务器收集候选地址，通常需要 2–6 秒。');
    try { state.rtc = await window.CMIWebRTC.run(CFG.stunServers || ['stun:stun.cloudflare.com:3478', 'stun:stun.miwifi.com:3478']); }
    catch (e) { state.rtc = { supported: false, candidates: [], error: String(e) }; }
    rtcRunning = false; btn.disabled = false;
    renderRtc(); renderEnv(); renderSharing();
  }
  $('#rtcBtn').addEventListener('click', checkRtc);

  function knownIps() { return [state.self?.ip, state.v4, state.v6].filter(Boolean); }
  function rtcVerdict() {
    const r = state.rtc;
    if (!r.supported) return { level: 'good', title: '浏览器未启用 WebRTC', text: '当前浏览器不支持或已禁用 WebRTC，网页无法通过它获取你的地址。', short: '已禁用', envText: 'WebRTC 不可用，不会泄露地址。' };
    const pub = r.candidates.filter((c) => c.kind === 'public');
    const known = knownIps();
    const leaked = pub.filter((c) => !known.includes(c.address));
    const priv = r.candidates.filter((c) => c.kind === 'private');
    if (leaked.length) return { level: 'bad', title: '可能存在 WebRTC 泄露', text: `WebRTC 暴露了与本站所见不同的公网 IP：${[...new Set(leaked.map((c) => c.address))].join('、')}。如果你正在使用代理 / VPN，真实 IP 可能已被网页获取。`, short: '发现不同的公网 IP', envText: `WebRTC 公网 IP 与 HTTP 所见不一致：${leaked[0].address}` };
    if (priv.length) return { level: 'warn', title: '暴露了内网地址', text: `未发现额外公网 IP，但 WebRTC 暴露了内网地址 ${priv.map((c) => c.address).join('、')}，可被用于辅助追踪。`, short: '暴露内网地址', envText: 'WebRTC 暴露了内网地址，但公网 IP 一致。' };
    if (pub.length) return { level: 'good', title: '未发现泄露', text: 'WebRTC 获取到的公网 IP 与本站看到的一致。', short: '一致', envText: 'WebRTC 公网 IP 与 HTTP 所见一致。' };
    if (r.candidates.length) return { level: 'good', title: '未发现泄露', text: '只收集到 mDNS 隐藏地址，STUN 未返回公网地址（可能 UDP 被拦截或已开启保护）。', short: '未获取到公网 IP', envText: 'WebRTC 未暴露公网 IP。' };
    return { level: 'good', title: '未收集到任何候选地址', text: '可能是浏览器或网络阻止了 WebRTC / UDP，这对隐私是好事。', short: '无候选地址', envText: 'WebRTC 未返回任何地址。' };
  }
  function setVerdict(level, title, text) {
    const v = $('#rtcVerdict');
    v.className = 'verdict ' + level;
    v.innerHTML = `<span class="verdict-ico">${level === 'loading' ? '' : icon(LEVEL_ICON[level] || 'info')}</span><div><b>${esc(title)}</b><p>${esc(text)}</p></div>`;
  }
  function renderRtc() {
    if (!state.rtc) return;
    const v = rtcVerdict(); setVerdict(v.level, v.title, v.text);
    const known = knownIps();
    const KIND = { public: '公网', private: '内网', mdns: 'mDNS 隐藏' };
    const TYPE = { host: 'host 本机', srflx: 'srflx 反射', prflx: 'prflx', relay: 'relay 中继' };
    const rows = state.rtc.candidates.map((c) => {
      let kind = `<span class="badge ${c.kind === 'public' ? (known.includes(c.address) ? 'good' : 'bad') : c.kind === 'private' ? 'warn' : 'soft'}">${KIND[c.kind]}${c.family ? ' ' + c.family : ''}${c.kind === 'public' && known.includes(c.address) ? ' · 与本站一致' : c.kind === 'public' ? ' · 不一致' : ''}</span>`;
      return `<tr><td class="mono">${esc(c.address)}</td><td>${kind}</td><td>${esc(TYPE[c.type] || c.type)}</td><td>${esc(c.protocol.toUpperCase())}</td><td class="muted">${esc(c.servers.map((s) => s.replace(/^stun:/, '')).join(', '))}</td></tr>`;
    });
    $('#rtcTable tbody').innerHTML = rows.join('') || `<tr><td colspan="5" class="muted">${state.rtc.supported ? '没有收集到候选地址' : '浏览器不支持 WebRTC'}</td></tr>`;
  }

  // ---------- 指纹 ----------
  function renderFp(f) {
    const gl = f.webgl || {};
    const items = [
      ['User-Agent', f.userAgent, 'wide mono'],
      ['平台', f.platform || '—'], ['语言', f.languages.join(', ') || '—'], ['时区', `${f.timezone || '—'}（${f.tzOffset}）`],
      ['屏幕分辨率', `${f.screen} @${f.dpr}x`], ['视口大小', f.viewport], ['色深', `${f.colorDepth} 位`],
      ['CPU 逻辑核心', f.cores ?? '不可用'], ['设备内存', f.memory ? `≥ ${f.memory} GB` : '不可用'], ['触控点数', f.touch],
      ['Canvas 指纹', f.canvas || '不可用', 'mono'], ['Cookie', f.cookies ? '已启用' : '已禁用'], ['Do Not Track', f.dnt ? '已开启' : '未开启'],
      ['WebGL 厂商', gl.supported ? gl.vendor || '—' : '不支持'], ['WebGL 渲染器', gl.supported ? gl.renderer || '—' : '不支持', 'half'],
      [`已安装字体（检测 ${f.fonts.length} 项命中）`, f.fonts.length ? f.fonts.join('、') : '未检测到常见字体', 'wide'],
    ];
    $('#fpGrid').innerHTML = items.map(([k, v, cls = '']) => `<div class="card fp-item ${cls.replace('mono', '')}"><div class="k">${esc(k)}</div><div class="v ${cls.includes('mono') ? 'mono' : ''}">${esc(v)}</div></div>`).join('');
    $('#fpHash').textContent = f.hash;
  }


  // ---------- 预估多少人在用这个 IP ----------
  const SHARE_CLASS = { household: 'good', residential: 'good', cn_broadband: 'warn', cgnat_mobile: 'teal', nat_large: 'purple', nat_org: 'warn', public_proxy: 'bad', server: 'soft', unknown: 'soft' };
  const CONF_CLASS = { high: 'good', medium: 'blue', low: 'soft' };
  const isV4 = (ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip || '');
  const inCgnat = (ip) => { if (!isV4(ip)) return false; const [a, b] = ip.split('.').map(Number); return a === 100 && b >= 64 && b <= 127; };

  // 客户端证据（只对你自己的 IP 有意义）：WebRTC 本地候选在 100.64.0.0/10；同一时刻看到多个公网 IPv4
  function cgnatEvidence() {
    const out = [];
    const r = state.rtc;
    if (r && r.candidates) {
      const cg = [...new Set(r.candidates.filter((c) => inCgnat(c.address)).map((c) => c.address))];
      if (cg.length) out.push({ level: 'warn', strong: 'cgnat', title: `WebRTC 发现 ${cg.join('、')}`, text: '这是运营商级 NAT 专用地址段（100.64.0.0/10），说明本机直接处在运营商 NAT 后面（例外：Tailscale 等组网软件也使用这一段）。' });
    }
    const pubs = new Set();
    if (isV4(state.v4)) pubs.add(state.v4);
    if (isV4(state.self?.ip)) pubs.add(state.self.ip);
    if (r && r.candidates) r.candidates.filter((c) => c.kind === 'public' && isV4(c.address)).forEach((c) => pubs.add(c.address));
    if (pubs.size > 1) out.push({ level: 'warn', strong: 'multi', title: '同一时刻出现多个公网 IPv4', text: `IPv4 探测、本站与 WebRTC 看到的公网 IPv4 不一致：${[...pubs].join('、')}。运营商级 NAT 常用一组出口 IP 轮换；使用代理 / VPN 分流时也会这样。` });
    if (r && r.supported && !out.length) out.push({ level: 'info', title: '未发现 CGNAT 迹象', text: 'WebRTC 未出现 100.64.x.x 地址，各处看到的公网 IPv4 也一致。但若 100.64.x.x 只出现在路由器 WAN 口，浏览器看不到，因此不能排除。' });
    return out;
  }

  function renderSharing() {
    const d = state.view;
    if (!d || !d.sharing) return;
    const s = d.sharing, mine = d.query === 'self';
    const hl = $('#shHeadline');
    hl.textContent = s.headline; hl.className = 'sh-headline ' + (SHARE_CLASS[s.kind] || 'soft');
    $('#shScene').textContent = s.scene || '';
    $('#shBadges').innerHTML = `<span class="badge ${CONF_CLASS[s.confidence] || 'soft'}">置信度 ${esc(s.confidenceText)}</span><span class="badge soft">仅为估算</span>`;
    const ev = mine ? cgnatEvidence() : [];
    const items = s.reasons.map((t) => ({ level: 'info', text: t })).concat(ev);
    $('#shReasons').innerHTML = items.map((c) => `<li class="${c.level}"><span class="ck">${icon(LEVEL_ICON[c.level])}</span><div>${c.title ? `<b>${esc(c.title)}</b><p>${esc(c.text)}</p>` : `<span>${esc(c.text)}</span>`}</div></li>`).join('');
    // 100.64/10 是直接证据；多个公网 IPv4 只是间接迹象（也可能是代理分流 / 多出口），措辞要区分
    const hasCgnat = ev.some((x) => x.strong === 'cgnat'), hasMulti = ev.some((x) => x.strong === 'multi');
    const sharedKind = ['cgnat_mobile', 'public_proxy', 'nat_large'].includes(s.kind);
    const evEl = $('#shEvidence');
    let evText = '';
    if (hasCgnat) evText = sharedKind ? '本机证据也支持：你处在运营商级 NAT 后面。' : '结合本机证据：WebRTC 看到了 100.64.x.x，你很可能处在运营商级 NAT 后面，这个 IP 可能被多户共用。';
    else if (hasMulti) evText = '结合本机证据：你同时有多个公网 IPv4，可能是运营商 NAT 轮换出口，也可能是代理 / VPN 分流或多出口网络。';
    evEl.hidden = !evText; evEl.className = 'sh-evidence'; evEl.textContent = evText;
    renderObserved(s.observed, d);
  }

  function renderObserved(o, d) {
    const box = $('#shStats'), note = $('#shObsNote');
    const tiles = (a, b) => `<div><b>${a}</b><span>近 30 天</span></div><div><b>${b}</b><span>近 7 天</span></div>`;
    if (!o || !o.shown) { box.className = 'sh-stats off'; box.innerHTML = tiles('—', '—'); note.textContent = (o && o.message) || '本站观测数只对你自己的 IP 显示。'; return; }
    if (!o.enabled) { box.className = 'sh-stats off'; box.innerHTML = tiles('未启用', '未启用'); note.textContent = '本站统计未启用' + (o.reason === 'db_error' ? '（暂时不可用）' : '') + '，只显示上面的类型估算。'; return; }
    box.className = 'sh-stats'; box.innerHTML = tiles(o.devices30d, o.devices7d);
    const scope = o.scope === '/64' ? `你所在的 IPv6 /64 网段` : `IP ${d.ip}`;
    note.textContent = `近 30 天在 ${scope} 上访问过本站的不同浏览器（按指纹去重${o.includesYou ? '，含你自己' : ''}）。只代表本站访客，实际使用人数可能更多。${o.notCounted || ''}`;
  }

  // 把指纹哈希报告给 /api/seen（同源、每页面一次；服务端只存加盐哈希、按天去重）
  let seenSent = false;
  async function reportSeen() {
    if (seenSent || !state.self || !state.fp || !state.fp.hash) return;
    seenSent = true;
    try {
      const r = await fetch('/api/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fp: state.fp.hash }) });
      const j = await r.json().catch(() => null);
      if (!j || !state.self.sharing) return;
      if (r.ok && j.observed) {
        const included = !!(j.recorded || j.alreadyCounted);
        const cap = j.observed.dailyCap || 30;
        const capNote = j.capped ? (included ? `今天这个 IP 上新出现的浏览器已达上限（每天最多计 ${cap} 个），之后的新浏览器今天不再计入。` : `今天这个 IP 上新出现的浏览器已达上限（每天最多计 ${cap} 个），本次访问未计入。`) : '';
        const pauseNote = j.paused ? (included ? '本站统计今日已暂停（全站今日新增记录已达上限），明天自动恢复；IP 检测不受影响。' : '本站统计今日已暂停（全站今日新增记录已达上限），本次访问未计入，明天自动恢复；IP 检测不受影响。') : '';
        state.self.sharing.observed = { ...j.observed, includesYou: included, notCounted: pauseNote || capNote };
      }
      else if (r.status === 429 && state.self.sharing.observed) state.self.sharing.observed = { ...state.self.sharing.observed, notCounted: '本次访问未计入（上报过于频繁，稍后刷新即可）。' };
      else if (j.enabled === false) state.self.sharing.observed = { shown: true, enabled: false, reason: j.reason, message: j.message };
      if (state.view === state.self) renderSharing();
    } catch (e) { /* 统计失败不影响页面 */ }
  }

  // ---------- 启动 ----------
  (async function init() {
    const q = new URLSearchParams(location.search).get('ip');
    if (q) $('#searchInput').value = q;
    window.CMIFingerprint.collect().then((f) => { state.fp = f; renderFp(f); renderEnv(); reportSeen(); });
    detectStack();
    try {
      await loadSelf();
      if (!q) renderIp(state.self);
    } catch (e) {
      if (!q) renderIpError(e.message);
      $('#envList').innerHTML = `<li class="info"><span class="ck">${icon('info')}</span><div><b>无法获取本站所见 IP</b><p>${esc(e.message)}</p></div></li>`;
      checkRtc();
    }
    if (q) show(q);
  })();
})();
