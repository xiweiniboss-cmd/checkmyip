// 前端可调配置（部署时按需修改）
window.CHECKMYIP_CONFIG = {
  // 仅 IPv4 / 仅 IPv6 的探测地址，用于分别检测访问者的 v4 与 v6 出口。
  // 绑定自有域名后建议改为本站子域（v4 子域只配 A 记录、v6 子域只配 AAAA 记录），例如：
  //   ipv4: ['https://v4.checkmyip.example.com/api/ip'], ipv6: ['https://v6.checkmyip.example.com/api/ip']
  // 返回纯文本 IP 或含 ip 字段的 JSON 均可；需允许跨域（CORS）。
  ipv4: ['https://api-ipv4.ip.sb/ip', 'https://api.ipify.org?format=json'],
  ipv6: ['https://api-ipv6.ip.sb/ip', 'https://api6.ipify.org?format=json'],
  stunServers: ['stun:stun.cloudflare.com:3478', 'stun:stun.miwifi.com:3478'],
};
