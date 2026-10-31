// WebRTC 候选地址收集：通过 STUN 获取 host / srflx 候选，判断是否暴露额外的公网 IP
(function () {
  'use strict';

  const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
  function isPrivate(ip) {
    if (IPV4_RE.test(ip)) {
      const p = ip.split('.').map(Number);
      return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
        (p[0] === 169 && p[1] === 254) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] === 0;
    }
    const l = ip.toLowerCase();
    return l === '::1' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd');
  }

  function parseCandidate(str) {
    // candidate:foundation component protocol priority address port typ type ...
    const parts = String(str || '').replace(/^a=/, '').split(/\s+/);
    if (parts.length < 8) return null;
    const typIdx = parts.indexOf('typ');
    return { protocol: (parts[2] || '').toLowerCase(), address: parts[4], type: typIdx > 0 ? parts[typIdx + 1] : '' };
  }

  function gatherFrom(server, timeoutMs) {
    return new Promise((resolve) => {
      const found = [];
      let pc;
      try {
        pc = new RTCPeerConnection({ iceServers: [{ urls: server }] });
      } catch (e) { resolve({ server, error: String(e.message || e), found }); return; }
      let done = false;
      const finish = () => { if (done) return; done = true; try { pc.close(); } catch (e) {} resolve({ server, found }); };
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) { finish(); return; }
        const c = ev.candidate;
        const parsed = parseCandidate(c.candidate);
        const address = c.address || (parsed && parsed.address);
        if (address) found.push({ address, type: c.type || (parsed && parsed.type) || '', protocol: c.protocol || (parsed && parsed.protocol) || '', server });
      };
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') finish(); };
      try {
        pc.createDataChannel('cmi');
        pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(finish);
      } catch (e) { finish(); }
      setTimeout(finish, timeoutMs);
    });
  }

  async function run(servers, timeoutMs = 6000) {
    if (typeof RTCPeerConnection === 'undefined') return { supported: false, candidates: [] };
    const results = await Promise.all(servers.map((s) => gatherFrom(s, timeoutMs)));
    const map = new Map();
    for (const r of results) for (const c of r.found) {
      const key = `${c.address}|${c.type}|${c.protocol}`;
      if (!map.has(key)) map.set(key, { ...c, servers: [c.server] }); else if (!map.get(key).servers.includes(c.server)) map.get(key).servers.push(c.server);
    }
    const candidates = [...map.values()].map((c) => ({
      ...c,
      kind: c.address.endsWith('.local') ? 'mdns' : isPrivate(c.address) ? 'private' : 'public',
      family: c.address.endsWith('.local') ? '' : c.address.includes(':') ? 'IPv6' : 'IPv4',
    }));
    return { supported: true, candidates, errors: results.filter((r) => r.error).map((r) => `${r.server}: ${r.error}`) };
  }

  window.CMIWebRTC = { run, isPrivate };
})();
