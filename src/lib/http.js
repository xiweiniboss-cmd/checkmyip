// 带超时的 fetch（默认 3 秒），失败返回 null 而不是抛异常
export async function fetchJSON(url, { timeout = 3000, headers = {}, cf } = {}) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; checkmyip/0.1)', accept: 'application/json', ...headers },
      ...(cf ? { cf } : {}),
    });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, data: await r.json() };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : String(e.message || e) };
  }
}

export async function fetchText(url, { timeout = 3000, cf } = {}) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { 'user-agent': 'checkmyip/0.1' }, ...(cf ? { cf } : {}) });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, data: await r.text() };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : String(e.message || e) };
  }
}
