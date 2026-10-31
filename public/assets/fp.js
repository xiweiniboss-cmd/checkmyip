// 浏览器指纹采集（自行实现，不依赖第三方库）。所有计算仅在本地进行。
(function () {
  'use strict';

  // 64 位哈希：两路 32 位 Murmur 风格混合（自写，非加密用途）
  function hash64(str) {
    let h1 = 0xdeadbeef ^ str.length, h2 = 0x41c6ce57 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }

  function canvasHash() {
    try {
      const c = document.createElement('canvas');
      c.width = 280; c.height = 60;
      const x = c.getContext('2d');
      if (!x) return null;
      x.textBaseline = 'top';
      x.fillStyle = '#f60'; x.fillRect(100, 1, 62, 20);
      x.fillStyle = '#069'; x.font = '15px Arial';
      x.fillText('checkmyip 指纹 ✓ 1.0 <canvas>', 2, 15);
      x.fillStyle = 'rgba(102, 204, 0, .7)'; x.font = '18px serif';
      x.fillText('Hello, 世界 ☺', 4, 34);
      x.globalCompositeOperation = 'multiply';
      x.fillStyle = 'rgb(255,0,255)'; x.beginPath(); x.arc(220, 30, 22, 0, Math.PI * 2); x.fill();
      x.fillStyle = 'rgb(0,255,255)'; x.beginPath(); x.arc(240, 30, 22, 0, Math.PI * 2); x.fill();
      return hash64(c.toDataURL());
    } catch (e) { return null; }
  }

  function webgl() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return { supported: false };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        supported: true,
        vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        version: gl.getParameter(gl.VERSION),
      };
    } catch (e) { return { supported: false }; }
  }

  // 轻量字体探测：对比文本宽度是否与通用字体回退不同
  const FONT_LIST = ['Microsoft YaHei', 'SimSun', 'SimHei', 'KaiTi', 'FangSong', 'DengXian', 'PingFang SC', 'Hiragino Sans GB',
    'STHeiti', 'Songti SC', 'Noto Sans CJK SC', 'Source Han Sans SC', 'WenQuanYi Micro Hei', 'Arial', 'Helvetica Neue',
    'Segoe UI', 'Calibri', 'Cambria', 'Consolas', 'Menlo', 'Monaco', 'Ubuntu', 'Roboto', 'DejaVu Sans', 'Liberation Sans'];
  function fonts() {
    try {
      const c = document.createElement('canvas').getContext('2d');
      const text = 'mmmmmmmmmmlli 你好世界 WwQ@#';
      const base = {};
      for (const b of ['monospace', 'sans-serif', 'serif']) { c.font = `72px ${b}`; base[b] = c.measureText(text).width; }
      return FONT_LIST.filter((f) => ['monospace', 'sans-serif', 'serif'].some((b) => {
        c.font = `72px "${f}", ${b}`; return c.measureText(text).width !== base[b];
      }));
    } catch (e) { return []; }
  }

  function tzOffsetStr(min) {
    const s = min <= 0 ? '+' : '-'; const a = Math.abs(min);
    return `UTC${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
  }

  async function collect() {
    const nav = navigator;
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return null; } })();
    const uaData = nav.userAgentData;
    let platform = nav.platform || '';
    let uaHigh = null;
    if (uaData && uaData.getHighEntropyValues) {
      try { uaHigh = await uaData.getHighEntropyValues(['platform', 'platformVersion', 'architecture', 'model', 'fullVersionList']); platform = uaHigh.platform || platform; } catch (e) {}
    }
    const gl = webgl();
    const f = fonts();
    const d = {
      userAgent: nav.userAgent,
      platform,
      languages: (nav.languages && nav.languages.length ? nav.languages : [nav.language]).filter(Boolean),
      timezone: tz,
      tzOffset: tzOffsetStr(new Date().getTimezoneOffset()),
      screen: `${screen.width} × ${screen.height}`,
      viewport: `${innerWidth} × ${innerHeight}`,
      dpr: window.devicePixelRatio || 1,
      colorDepth: screen.colorDepth,
      cores: nav.hardwareConcurrency || null,
      memory: nav.deviceMemory || null,
      touch: nav.maxTouchPoints || 0,
      cookies: nav.cookieEnabled,
      dnt: nav.doNotTrack === '1' || window.doNotTrack === '1',
      webdriver: !!nav.webdriver,
      canvas: canvasHash(),
      webgl: gl,
      fonts: f,
    };
    const stable = [d.userAgent, d.platform, d.languages.join(','), d.timezone, d.screen, d.dpr, d.colorDepth, d.cores, d.memory,
      d.touch, d.canvas, gl.vendor, gl.renderer, f.join(',')].join('|');
    d.hash = hash64(stable);
    return d;
  }

  window.CMIFingerprint = { collect, hash64 };
})();
