// 前端可调配置（部署时按需修改）
(function () {
  // 你的站点域名（不带协议），例如 'checkmyip.example.com'。
  // 设置后会使用本站的 https://v4.<域名>/api/ip 与 https://v6.<域名>/api/ip 分别探测 IPv4 / IPv6 出口
  // （v4 子域只配 A 记录、v6 子域只配 AAAA 记录，见 README「自定义域名」）。
  // 留空（占位）时退回 ip.sb 的公共接口；未使用 ipify（国内访问不稳定）。
  const SITE_DOMAIN = ''; // TODO: 部署者确定域名后填写

  const own = SITE_DOMAIN && !/example\.com$/.test(SITE_DOMAIN);
  window.CHECKMYIP_CONFIG = {
    siteDomain: own ? SITE_DOMAIN : null,
    // 返回纯文本 IP 或含 ip 字段的 JSON 均可；需允许跨域（CORS）
    ipv4: own ? [`https://v4.${SITE_DOMAIN}/api/ip`] : ['https://api-ipv4.ip.sb/ip'],
    ipv6: own ? [`https://v6.${SITE_DOMAIN}/api/ip`] : ['https://api-ipv6.ip.sb/ip'],
    stunServers: ['stun:stun.cloudflare.com:3478', 'stun:stun.miwifi.com:3478'],
  };
})();
