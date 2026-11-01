// Claude 环境检测页：所有检测在浏览器本地完成。
// 外部请求：claude.ai / 1.1.1.1 / api.anthropic.com 的 /cdn-cgi/trace（CORS *）、my.ip.cn（CORS *）、STUN。
// 发给本站的只有：/api/ip（自己的 IP）与 /api/ip?ip=<Claude 出口 IP>。国内出口 IP 永不上传。
(function () {
  'use strict';
  const R = window.CMIClaudeRules;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ASSET_V = (document.querySelector('meta[name="checkmyip-asset-version"]') || {}).content || '';
  const icon = (id) => `<svg viewBox="0 0 24 24"><use href="/assets/icons.svg${ASSET_V ? `?v=${ASSET_V}` : ''}#${id}"/></svg>`;
  const LV_ICON = { good: 'ok', warn: 'warn', bad: 'bad', info: 'info' };
  const COLOR = { good: 'var(--good)', warn: 'var(--warn)', bad: 'var(--bad)', info: 'var(--info)' };
  let regionName = (cc) => cc;
  try { const dn = new Intl.DisplayNames(['zh-CN'], { type: 'region' }); regionName = (cc) => { try { return dn.of(cc) || cc; } catch (e) { return cc; } }; } catch (e) {}

  // ---------- 主题 ----------
  $('#themeBtn').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('cmi-theme', next); } catch (e) {}
  });

  // ---------- 网络工具 ----------
  async function fetchText(url, timeoutMs = 7000, opts = {}) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = performance.now();
    try {
      const r = await fetch(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ac.signal, ...opts });
      const text = opts.mode === 'no-cors' ? '' : await r.text();
      return { ok: opts.mode === 'no-cors' || r.ok, text, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, error: e.name === 'AbortError' ? '超时' : e.name === 'TypeError' ? '无法访问' : String(e.message || e), ms: null };
    } finally { clearTimeout(t); }
  }
  async function trace(host) {
    const r = await fetchText(`https://${host}/cdn-cgi/trace`);
    if (!r.ok) return { ok: false, error: r.error || '请求失败' };
    const t = R.parseTrace(r.text);
    return { ok: !!t.ip, ip: t.ip || null, loc: t.loc || null, colo: t.colo || null, warp: t.warp || null, ms: r.ms };
  }
  // 延迟：第一次请求含 TLS 握手，额外测 3 次取中位数
  async function latency(host) {
    const xs = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetchText(`https://${host}/cdn-cgi/trace?t=${Date.now()}`, 5000);
      if (r.ok && r.ms != null) xs.push(r.ms);
    }
    if (!xs.length) return null;
    xs.sort((a, b) => a - b);
    return xs[Math.floor(xs.length / 2)];
  }
  async function cnExit() {
    const r = await fetchText('https://my.ip.cn/', 6000);
    if (!r.ok) return { ok: false, error: r.error || '请求失败' };
    const p = R.parseMyIpCn(r.text);
    return p ? { ok: true, ...p } : { ok: false, error: '无法解析' };
  }
  async function api(ip) {
    const r = await fetch('/api/ip' + (ip ? `?ip=${encodeURIComponent(ip)}` : ''), { headers: { accept: 'application/json' } });
    let d = null; try { d = await r.json(); } catch (e) {}
    if (!d || !d.ok) throw new Error((d && d.message) || `HTTP ${r.status}`);
    return d;
  }
  function offsetMinutes(tz) {
    try {
      const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName').value;
      const m = s.match(/GMT([+-])(\d{2}):?(\d{2})?/); if (!m) return 0;
      return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
    } catch (e) { return null; }
  }

  // ---------- 浏览器环境 ----------
  const SC_FONTS = ['Microsoft YaHei', 'SimSun', 'NSimSun', 'SimHei', 'KaiTi', 'FangSong', 'DengXian', 'PingFang SC', 'Hiragino Sans GB', 'STHeiti',
    'Songti SC', 'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', 'WenQuanYi Micro Hei', 'WenQuanYi Zen Hei'];
  const TC_FONTS = ['Microsoft JhengHei', 'PMingLiU', 'MingLiU', 'PingFang TC', 'PingFang HK', 'Noto Sans CJK TC', 'Source Han Sans TC'];
  function detectFonts(list) {
    try {
      const c = document.createElement('canvas').getContext('2d');
      const text = '中文字体检测 你好世界 mmmmllii';
      const base = {};
      for (const b of ['monospace', 'sans-serif', 'serif']) { c.font = `64px ${b}`; base[b] = c.measureText(text).width; }
      return list.filter((f) => ['monospace', 'sans-serif', 'serif'].some((b) => { c.font = `64px "${f}", ${b}`; return c.measureText(text).width !== base[b]; }));
    } catch (e) { return []; }
  }
  function browserEnv() {
    let tz = null, locale = null;
    try { const o = Intl.DateTimeFormat().resolvedOptions(); tz = o.timeZone; locale = o.locale; } catch (e) {}
    const languages = (navigator.languages && navigator.languages.length ? [...navigator.languages] : [navigator.language]).filter(Boolean);
    return { timezone: tz, locale, languages, offsetMinutes: -new Date().getTimezoneOffset(), fonts: { sc: detectFonts(SC_FONTS), tc: detectFonts(TC_FONTS) } };
  }

  // ---------- 渲染 ----------
  function setGauge(prefix, score, level, label) {
    const card = $(`#${prefix}Card`);
    card.style.setProperty('--gauge-color', COLOR[level] || 'var(--primary)');
    $(`#${prefix}Bar`).setAttribute('stroke-dasharray', `${Math.max(0.5, score)} 100`);
    $(`#${prefix}Num`).textContent = score;
    $(`#${prefix}Label`).textContent = label;
  }
  function signalLi(level, title, detail, effectHtml) {
    return `<li class="signal ${level}"><span class="sig-ico">${icon(LV_ICON[level] || 'info')}</span>
      <div><div class="sig-name">${esc(title)}</div><div class="sig-detail">${esc(detail)}</div></div>${effectHtml || '<span></span>'}</li>`;
  }
  function exitRow(label, sub, r, extra) {
    let val, tag = '';
    if (!r) { val = '<span class="val none">检测中…</span>'; }
    else if (!r.ok) { val = `<span class="val none">获取失败（${esc(r.error || '无法访问')}）</span>`; tag = '<span class="badge soft">不可用</span>'; }
    else {
      val = `<span class="val">${esc(r.ip)}</span>`;
      const cc = r.loc;
      const where = cc ? `${regionName(cc)} · ${cc}` : (r.location || '');
      if (where) tag = `<span class="badge ${extra || 'soft'}">${esc(where)}</span>`;
    }
    return `<li><span class="proto">${esc(label)}</span><div class="exit-main">${val}<span class="exit-sub">${esc(sub)}</span></div>${tag}</li>`;
  }

  function renderExits(s) {
    const cRs = s.claude && s.claude.ok ? R.regionStatus(s.claude.loc) : null;
    const cTag = cRs ? (cRs.status === 'supported' ? 'good' : cRs.status === 'unsupported' ? 'bad' : 'warn') : 'soft';
    const colo = (r) => (r && r.ok && r.colo ? ` · 节点 ${r.colo}` : '');
    $('#exitList').innerHTML = [
      exitRow('Claude', `访问 claude.ai 时的出口${colo(s.claude)}${s.claude && s.claude.warp === 'on' ? ' · WARP' : ''}`, s.claude, cTag),
      exitRow('海外', `访问 1.1.1.1 时的出口${colo(s.cf)}`, s.cf),
      exitRow('国内', '访问 my.ip.cn 时的出口（只在本地显示）', s.cn),
      exitRow('本站', '访问 checkmyip 时的出口', s.site ? { ok: true, ip: s.site.ip, loc: s.site.location && s.site.location.countryCode } : s.siteErr ? { ok: false, error: s.siteErr } : null),
    ].join('');
  }

  function renderNet(net, s) {
    setGauge('net', net.score, net.level, net.text);
    const cc = s.claude && s.claude.ok ? (s.claude.loc || '') : '';
    $('#netRegion').textContent = cc ? `${regionName(cc)}` : '—';
    $('#netType').textContent = s.ipInfo && s.ipInfo.analysis ? (s.ipInfo.analysis.typeText || s.ipInfo.analysis.type) : '—';
    $('#netLatency').textContent = s.claude && s.claude.ms != null ? `${s.claude.ms} ms` : '—';
    $('#netItems').innerHTML = net.items.map((x) => signalLi(x.level, x.title, x.detail,
      x.effect < 0 ? `<span class="sig-effect neg">${x.effect <= -90 ? '封顶' : x.effect}</span>` : '<span class="sig-effect">—</span>')).join('');
  }

  function renderBrowser(br) {
    setGauge('br', br.score, br.level, br.text);
    $('#brItems').innerHTML = br.items.map((x) => signalLi(x.level, `${x.title}：${x.raw}`, x.detail,
      `<span class="sig-effect ${x.points > 0 ? 'neg' : ''}">${x.points}/${x.weight}</span>`)).join('');
  }

  function renderVerdict(v) {
    const el = $('#cvVerdict');
    el.className = `verdict ${v.level}`;
    el.querySelector('.verdict-ico').innerHTML = v.level === 'info' ? '' : icon(LV_ICON[v.level]);
    $('#cvVerdictTitle').textContent = v.title;
    $('#cvVerdictText').textContent = v.text;
  }

  function renderRegions() {
    const list = [...R.SUPPORTED].map((cc) => ({ cc, name: regionName(cc) })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    $('#regionCount').textContent = list.length;
    $('#regionList').innerHTML = list.map((x) => `<span class="badge soft" title="${x.cc}">${esc(x.name)} <small>${x.cc}</small></span>`).join('');
  }

  // ---------- 主流程 ----------
  let running = false;
  async function run() {
    if (running) return; running = true;
    const btn = $('#rerunBtn'); btn.disabled = true;
    $('#cvVerdict').className = 'verdict loading'; $('#cvVerdict').querySelector('.verdict-ico').innerHTML = '';
    $('#cvVerdictTitle').textContent = '检测中…'; $('#cvVerdictText').textContent = '正在获取各条线路的出口 IP。';
    const s = {};
    renderExits(s);

    const br = R.scoreBrowser(browserEnv());
    renderBrowser(br);

    const cfg = window.CHECKMYIP_CONFIG || {};
    const rtcP = window.CMIWebRTC ? window.CMIWebRTC.run(cfg.stunServers || ['stun:stun.cloudflare.com:3478'], 5000).catch(() => null) : Promise.resolve(null);
    const siteP = api().then((d) => { s.site = d; }, (e) => { s.siteErr = e.message; });
    const [claude, cf, cn] = await Promise.all([
      trace('claude.ai').then((r) => { s.claude = r; renderExits(s); return r; }),
      trace('1.1.1.1').then((r) => { s.cf = r; renderExits(s); return r; }),
      cnExit().then((r) => { s.cn = r; renderExits(s); return r; }),
    ]);
    await siteP; renderExits(s);

    if (claude.ok) {
      const lat = await latency('claude.ai');
      if (lat != null) claude.ms = lat;
      try { s.ipInfo = s.site && s.site.ip === claude.ip ? s.site : await api(claude.ip); } catch (e) { s.ipInfo = null; }
    }
    const rtcRaw = await rtcP;
    const rtc = rtcRaw ? { supported: !!rtcRaw.supported, publicIps: [...new Set((rtcRaw.candidates || []).map((c) => c.address).filter((a) => a && !a.endsWith('.local') && !window.CMIWebRTC.isPrivate(a)))] } : null;

    const browserTz = br.items[0].raw;
    const ipTz = s.ipInfo && s.ipInfo.location && s.ipInfo.location.timezone;
    const tz = ipTz ? { browserTz, ipTz, browserOffset: -new Date().getTimezoneOffset(), ipOffset: offsetMinutes(ipTz) } : null;

    const net = R.scoreNetwork({ claude, cf, cn, site: s.site, ipInfo: s.ipInfo, tz, rtc });
    renderNet(net, s);
    renderVerdict(R.overall(net, br));
    btn.disabled = false; running = false;
  }

  $('#rerunBtn').addEventListener('click', run);
  renderRegions();
  run();
})();
